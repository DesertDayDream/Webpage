// Mountable variant of server.js — for embedding Slam Royale into an EXISTING
// Node/Express process (Webpage's server.js) instead of running as its own
// standalone http.Server on its own port. server.js itself is untouched and still
// works for standalone local dev (`node server/server.js`); this is the alternate
// entry point Webpage's server.js loads via dynamic import() (it's CommonJS, this
// project is ESM — that's the standard bridge between the two module systems).
//
// Everything server.js does EXCEPT owning the http.Server/listen() call lives here:
// config bootstrap, the WebSocketServer (scoped to its own `path` so it doesn't
// collide with Webpage's existing unscoped one — see WS_PATH below and the matching
// change on client/net.js's connect()), and the fixed-step room tick loop.

import { WebSocketServer } from 'ws';
import { NET, CFG, MSG, applyMoveDurations, applyHitboxScale, applyGameConfig, applyMovesBalance } from '../shared/constants.js';
import { roomManager } from './rooms.js';
import { handleApi } from './api.js';
import { stmt } from './db.js';

export const WS_PATH = '/slam-royale/ws';

export function mountSlamRoyale() {
  // move durations + hit reach follow whatever the admin's default character has
  // mapped; match balance same as server.js's own startup block — see there for
  // the full reasoning, unchanged here.
  {
    const row = stmt.getDefaultCharacter.get();
    applyMoveDurations(row ? JSON.parse(row.durations || '{}') : {});
    applyHitboxScale(row ? row.size_ratio : 1);
  }
  {
    const gc = stmt.getGameConfig.get();
    const parsed = gc ? JSON.parse(gc.data || '{}') : {};
    applyGameConfig(parsed);
    applyMovesBalance(parsed.moves || {});
  }

  // noServer: true — ws's own path-matching (via a `path` option + `{server}`)
  // does NOT gracefully coexist with a second WebSocketServer on the same
  // httpServer: internally, EVERY WebSocketServer attached this way reacts to
  // EVERY upgrade event regardless of path, and aborts the handshake itself
  // (writes a 400, destroys the socket) the instant its own path doesn't match —
  // so whichever WebSocketServer is registered first kills any request meant for
  // the other one before it's ever seen. The standard fix: both servers use
  // noServer:true (construct only, no upgrade listener of their own), and the
  // caller (Webpage's server.js) runs ONE manual httpServer.on('upgrade', ...)
  // dispatcher that routes by path to whichever instance's handleUpgrade() the
  // request actually matches.
  const wss = new WebSocketServer({ noServer: true });

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

  setInterval(() => roomManager.tickAll(NET.FIXED_DT), 1000 * NET.FIXED_DT);

  // handleApi: Webpage's server.js wires this in as Express middleware mounted at
  // '/slam-royale' — Express strips that mount prefix from req.url before this
  // ever sees it, so req.url arrives as '/api/default-character' etc., exactly
  // what handleApi's own route table (server/api.js) already expects unmodified.
  // wss: Webpage's server.js registers this in its single unified
  // httpServer.on('upgrade', ...) dispatcher (see the noServer note above) —
  // routing a request matching WS_PATH to wss.handleUpgrade() is this module's
  // caller's responsibility, not this module's own.
  return { handleApi, wss };
}
