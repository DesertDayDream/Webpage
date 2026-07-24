// Serves the client and runs the authoritative match loop. Multi-room matchmaking:
// each connection resolves to a Room (see server/rooms.js for the lobby → starting →
// active → destroyed lifecycle) via auto-assignment, an explicit roomId, or the
// Studio's solo-preview bypass — there is no longer a single global World.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { NET, CFG, MSG, applyMoveDurations, applyHitboxScale, applyGameConfig, applyMovesBalance } from '../shared/constants.js';
import { roomManager } from './rooms.js';
import { handleApi } from './api.js';
import { stmt } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8080;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

// --- static file server (serves /client and /shared) + /api/* (accounts + saved characters) ---
const server = http.createServer((req, res) => {
  const p0 = decodeURIComponent(req.url.split('?')[0]);
  if (p0.startsWith('/api/')) { handleApi(req, res, p0); return; }
  let p = p0;
  if (p === '/') p = '/client/index.html';
  const fp = path.join(ROOT, path.normalize(p));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// move durations + hit reach follow whatever the admin's default character has mapped
// (so a custom clip's real length, and the model's real on-screen size, override the
// built-in procedural-rig numbers) — load them once at startup; server/api.js keeps
// this live as the admin edits the character.
{
  const row = stmt.getDefaultCharacter.get();
  applyMoveDurations(row ? JSON.parse(row.durations || '{}') : {});
  applyHitboxScale(row ? row.size_ratio : 1);
}

// match balance (movement/input/zone/items/superstar + per-move combat balance, plus
// the lobby countdown/starting-buffer added with multi-room matchmaking) — same
// pattern as above, read once at startup, kept live by server/api.js afterward. Must
// run before any Room/World gets created since CFG is read at construction time.
{
  const gc = stmt.getGameConfig.get();
  const parsed = gc ? JSON.parse(gc.data || '{}') : {};
  applyGameConfig(parsed);
  applyMovesBalance(parsed.moves || {});
}

// --- realtime ---
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const conn = { room: null };   // resolved once a JOIN lands on this socket

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === MSG.JOIN) {
      if (conn.room) return;   // already joined a room on this socket
      let room, rejectReason = null;
      if (m.solo) {
        room = roomManager.createSoloRoom();
      } else if (m.roomId) {
        room = roomManager.getRoom(m.roomId);
        if (!room) rejectReason = 'room-not-found';
        else if (!room.isJoinable()) rejectReason = room.phase === 'waiting' ? 'room-full' : 'room-started';
      } else {
        room = roomManager.findOpenRoom() || roomManager.createRoom();
      }
      if (rejectReason) { ws.send(JSON.stringify({ type: MSG.JOIN_REJECTED, reason: rejectReason })); return; }
      conn.room = room;
      const id = room.addPendingPlayer(ws, m.name, m.char);
      ws.send(JSON.stringify({ type: MSG.WELCOME, id, roomId: room.id, fixedDt: NET.FIXED_DT, interpMs: NET.INTERP_MS, maxPlayers: CFG.maxPlayers }));
    } else if (m.type === MSG.INPUT) {
      conn.room?.setInput(ws, m.seq, m.cmd);
    }
  });

  ws.on('close', () => {
    if (!conn.room) return;
    const empty = conn.room.removeClient(ws);
    if (empty) roomManager.destroyRoom(conn.room.id);
    conn.room = null;
  });
});

// --- fixed-step authoritative loop, one shared timer driving every room ---
setInterval(() => roomManager.tickAll(NET.FIXED_DT), 1000 * NET.FIXED_DT);

server.listen(PORT, () => console.log(`Slam Royale running → http://localhost:${PORT}`));
