const crypto   = require('crypto');
const express  = require('express');
const Database = require('better-sqlite3');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

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

app.listen(PORT, function() {
  console.log('Terminal running at http://localhost:' + PORT);
});
