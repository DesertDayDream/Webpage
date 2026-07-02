const crypto   = require('crypto');
const express  = require('express');
const Database = require('better-sqlite3');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { WebSocketServer } = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIG ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'genx1985';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DATA_DIR   = process.env.DATA_DIR   || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DB_PATH    = path.join(DATA_DIR, 'site.db');

// Origins allowed for cross-origin requests (comma-separated in CORS_ORIGIN env var)
var CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map(function(s) { return s.trim(); }).filter(Boolean);

// Cookie flags — cross-origin needs SameSite=None; Secure
var COOKIE_FLAGS = CORS_ORIGINS.length
  ? '; HttpOnly; SameSite=None; Secure; Path=/'
  : '; HttpOnly; SameSite=Strict; Path=/';

// Ensure runtime directories exist
fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// SQLite
const db = new Database(DB_PATH);
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY)');

const stmtGet        = db.prepare('SELECT value FROM kv WHERE key = ?');
const stmtUpsert     = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
const stmtAddSession = db.prepare('INSERT OR IGNORE INTO sessions (token) VALUES (?)');
const stmtDelSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtHasSession = db.prepare('SELECT 1 FROM sessions WHERE token = ?');

function getToken(req) {
  var m = (req.headers.cookie || '').match(/(?:^|;\s*)trm_session=([^;]+)/);
  return m ? m[1] : null;
}
function requireAuth(req, res, next) {
  if (stmtHasSession.get(getToken(req))) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ── CORS ──
app.use(function(req, res, next) {
  var origin = req.headers.origin || '';
  var isLocal = /^https?:\/\/localhost(:\d+)?$/.test(origin);
  if (origin && (isLocal || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// File upload — unique timestamped filenames, preserve extension
const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOAD_DIR); },
  filename: function(req, file, cb) {
    var unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/data', function(req, res) { res.status(403).end(); }); // block DB from public access
app.use(express.static(__dirname));

// ── API ──

// POST /api/login ← { password }
app.post('/api/login', function(req, res) {
  try {
    if (!req.body || req.body.password !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'wrong password' });
    var token = crypto.randomBytes(32).toString('hex');
    stmtAddSession.run(token);
    res.setHeader('Set-Cookie', 'trm_session=' + token + COOKIE_FLAGS);
    res.json({ ok: true });
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/logout
app.post('/api/logout', function(req, res) {
  stmtDelSession.run(getToken(req));
  res.setHeader('Set-Cookie', 'trm_session=' + COOKIE_FLAGS + '; Max-Age=0');
  res.json({ ok: true });
});

// GET /api/auth-check
app.get('/api/auth-check', function(req, res) {
  res.json({ admin: !!stmtHasSession.get(getToken(req)) });
});

// GET /api/data → { pages, settings }
app.get('/api/data', function(req, res) {
  var pRow = stmtGet.get('pages');
  var sRow = stmtGet.get('settings');
  res.json({
    pages:    pRow ? JSON.parse(pRow.value) : null,
    settings: sRow ? JSON.parse(sRow.value) : null
  });
});

// POST /api/data ← { pages?, settings? }  [auth required]
app.post('/api/data', requireAuth, function(req, res) {
  var pages    = req.body.pages;
  var settings = req.body.settings;
  if (pages    !== undefined) stmtUpsert.run('pages',    JSON.stringify(pages));
  if (settings !== undefined) stmtUpsert.run('settings', JSON.stringify(settings));
  res.json({ ok: true });
});

// POST /api/upload ← multipart file → { url }  [auth required]
app.post('/api/upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'no file received' });
  res.json({ url: PUBLIC_URL + '/uploads/' + req.file.filename });
});

// GET /api/mercs-config → { config } — the published devtool config every
// player's game.html loads on start. Public: every player needs to read it,
// not just the admin.
app.get('/api/mercs-config', function(req, res) {
  var row = stmtGet.get('mercs_config');
  res.json({ config: row ? JSON.parse(row.value) : null });
});

// POST /api/mercs-config ← { config }  [auth required] — publishes the
// admin's devtool state (balance/map/enemies/loot/sprites/anchors) so it
// takes effect for everyone, not just the admin's own browser.
app.post('/api/mercs-config', requireAuth, function(req, res) {
  if (!req.body || req.body.config === undefined) return res.status(400).json({ error: 'missing config' });
  stmtUpsert.run('mercs_config', JSON.stringify(req.body.config));
  res.json({ ok: true });
});

// ── MULTIPLAYER (WebSocket lobby + relay) ──
//
// Thin relay: this server doesn't understand game rules. It just tracks lobby
// membership and forwards messages between clients in the same lobby. All
// simulation stays in game.html (host-authoritative for enemies/pickups,
// client-authoritative for each player's own movement).
//
// Lobbies are kept fully in-memory (no SQLite) — they're live coordination
// state, not durable content, and every socket drops on a process restart
// anyway (railway.json restarts ON_FAILURE), so a persisted row would just be
// orphaned data.

const MAX_PLAYERS = 4;
const lobbies = new Map(); // lobbyId -> { id, name, hostId, state, players: Map<playerId,{id,name,ws}> }
const clients = new Map(); // ws -> { id, name, lobbyId }

function genId() { return crypto.randomBytes(8).toString('hex'); }

function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(Object.assign({ type: type }, data || {})));
}

function lobbySummary(lobby) {
  var host = lobby.players.get(lobby.hostId);
  return {
    id: lobby.id,
    name: lobby.name,
    hostName: host ? host.name : '',
    playerCount: lobby.players.size,
    maxPlayers: MAX_PLAYERS,
    state: lobby.state,
  };
}

function lobbyFull(lobby) {
  return {
    id: lobby.id,
    name: lobby.name,
    hostId: lobby.hostId,
    state: lobby.state,
    maxPlayers: MAX_PLAYERS,
    players: Array.from(lobby.players.values()).map(function(p) { return { id: p.id, name: p.name }; }),
  };
}

function broadcastLobbies() {
  var list = Array.from(lobbies.values())
    .filter(function(l) { return l.state === 'waiting'; })
    .map(lobbySummary);
  // Broadcasting to every connected socket (rather than tracking who's on the
  // browse screen) is trivial at this scale — clients just ignore it unless
  // they're currently showing the lobby list.
  clients.forEach(function(info, ws) { send(ws, 'lobbies', { list: list }); });
}

function broadcastLobby(lobby) {
  var payload = lobbyFull(lobby);
  lobby.players.forEach(function(p) { send(p.ws, 'lobby', { lobby: payload }); });
}

function leaveLobby(ws) {
  var info = clients.get(ws);
  if (!info || !info.lobbyId) return;
  var lobby = lobbies.get(info.lobbyId);
  var lobbyId = info.lobbyId;
  info.lobbyId = null;
  if (!lobby) return;

  var wasHost = lobby.hostId === info.id;
  lobby.players.delete(info.id);

  if (lobby.players.size === 0) {
    lobbies.delete(lobbyId);
    broadcastLobbies();
    return;
  }

  if (wasHost && lobby.state === 'playing') {
    // Host disconnecting mid-match ends it for everyone — no host migration
    // mid-game. Final scores aren't available here (only the host tracks
    // them), so this is an empty-scores end — an accepted edge case of the
    // "no mid-match migration" scope cut.
    lobby.players.forEach(function(p) {
      send(p.ws, 'ended', { scores: {} });
      var pInfo = clients.get(p.ws);
      if (pInfo) pInfo.lobbyId = null;
    });
    lobbies.delete(lobbyId);
    broadcastLobbies();
    return;
  }

  if (wasHost) lobby.hostId = lobby.players.keys().next().value;

  broadcastLobby(lobby);
  broadcastLobbies();
}

var httpServer = app.listen(PORT, function() {
  console.log('Terminal running at http://localhost:' + PORT);
});

var wss = new WebSocketServer({ server: httpServer });

wss.on('connection', function(ws) {
  clients.set(ws, { id: genId(), name: null, lobbyId: null });

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    var info = clients.get(ws);
    if (!info || !msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      info.name = String(msg.name || 'Player').slice(0, 20) || 'Player';
      send(ws, 'welcome', { id: info.id });
      return;
    }
    if (!info.name) return; // must hello first

    if (msg.type === 'list') {
      var list = Array.from(lobbies.values())
        .filter(function(l) { return l.state === 'waiting'; })
        .map(lobbySummary);
      send(ws, 'lobbies', { list: list });
      return;
    }

    if (msg.type === 'create') {
      if (info.lobbyId) leaveLobby(ws);
      var lobby = {
        id: genId(),
        name: String(msg.name || (info.name + "'s Lobby")).slice(0, 30) || (info.name + "'s Lobby"),
        hostId: info.id,
        state: 'waiting',
        players: new Map(),
      };
      lobby.players.set(info.id, { id: info.id, name: info.name, ws: ws });
      lobbies.set(lobby.id, lobby);
      info.lobbyId = lobby.id;
      broadcastLobby(lobby);
      broadcastLobbies();
      return;
    }

    if (msg.type === 'join') {
      var lobby = lobbies.get(msg.lobbyId);
      if (!lobby || lobby.state !== 'waiting') return send(ws, 'error', { code: 'lobby_not_found', message: 'Lobby not found' });
      if (lobby.players.size >= MAX_PLAYERS) return send(ws, 'error', { code: 'lobby_full', message: 'Lobby is full' });
      if (info.lobbyId) leaveLobby(ws);
      lobby.players.set(info.id, { id: info.id, name: info.name, ws: ws });
      info.lobbyId = lobby.id;
      broadcastLobby(lobby);
      broadcastLobbies();
      return;
    }

    if (msg.type === 'leave') { leaveLobby(ws); return; }

    if (msg.type === 'start') {
      var lobby = lobbies.get(info.lobbyId);
      if (!lobby) return;
      if (lobby.hostId !== info.id) return send(ws, 'error', { code: 'not_host', message: 'Only the host can start the match' });
      lobby.state = 'playing';
      var full = lobbyFull(lobby);
      lobby.players.forEach(function(p) { send(p.ws, 'started', { players: full.players, hostId: full.hostId }); });
      broadcastLobbies();
      return;
    }

    if (msg.type === 'end') {
      var lobby = lobbies.get(info.lobbyId);
      if (!lobby || lobby.hostId !== info.id) return;
      lobby.players.forEach(function(p) {
        send(p.ws, 'ended', { scores: msg.scores || {} });
        var pInfo = clients.get(p.ws);
        if (pInfo) pInfo.lobbyId = null;
      });
      lobbies.delete(lobby.id);
      broadcastLobbies();
      return;
    }

    // Everything below is in-match relay — requires being in a 'playing' lobby.
    var lobby = lobbies.get(info.lobbyId);
    if (!lobby || lobby.state !== 'playing') return;

    if (msg.type === 'state') {
      lobby.players.forEach(function(p) {
        if (p.id !== info.id) send(p.ws, 'state', { from: info.id, kind: msg.kind, data: msg.data });
      });
      return;
    }

    if (msg.type === 'hit' || msg.type === 'claim') {
      var host = lobby.players.get(lobby.hostId);
      if (!host || host.id === info.id) return; // host applies its own hits locally, no round trip needed
      var payload = { from: info.id };
      if (msg.type === 'hit') { payload.enemyId = msg.enemyId; payload.dmg = msg.dmg; payload.isMelee = !!msg.isMelee; }
      else { payload.pickupId = msg.pickupId; }
      send(host.ws, msg.type, payload);
      return;
    }
  });

  ws.on('close', function() {
    leaveLobby(ws);
    clients.delete(ws);
  });
});
