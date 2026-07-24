// Multi-room matchmaking: each Room owns its own World (or none yet, during the
// pre-match lobby) and its own set of connected sockets. server.js no longer talks to
// a single global World directly — it resolves/creates a Room per join and defers
// everything else here. See shared/constants.js's CFG.lobbyCountdown/lobbyStartBuffer.
//
// Lifecycle: 'waiting' (accumulating joiners, no World yet) → 'starting' (a short
// fixed buffer so clients can load character assets before the match actually starts
// ticking) → 'active' (World exists, stepping + broadcasting snapshots) → destroyed.
// Rooms are never recycled back into a fresh lobby — a finished room's sockets are
// closed and the Room is dropped; playing again means rejoining through the lobby
// list, same cost as today's "click Enter match" and keeps one socket's lifetime
// mapped to exactly one match.

import { CFG, MSG } from '../shared/constants.js';
import { World } from './world.js';

let nextRoomId = 1;

export class Room {
  constructor(id, { solo = false } = {}) {
    this.id = id;
    this.solo = solo;                 // Studio's instant-preview bypass — never listed/auto-joined, skips the wait entirely
    this.phase = 'waiting';           // 'waiting' | 'starting' | 'active'
    this.countdownT = solo ? 0 : CFG.lobbyCountdown;
    this.startingT = solo ? 0 : CFG.lobbyStartBuffer;
    this.pending = new Map();         // id -> { name, char }, only during waiting/starting
    this.clients = new Map();         // ws -> { id, ack }
    this.world = null;
    this.resetTimer = 0;
    this._nextId = 1;
    this._lobbyBcT = 0;                // throttles 'waiting' broadcasts to ~1/s
  }

  isJoinable() { return !this.solo && this.phase === 'waiting' && this.pending.size < CFG.maxPlayers; }

  addPendingPlayer(ws, name, char) {
    const id = 'p' + (this._nextId++);
    this.pending.set(id, { name: (name || '').slice(0, 16), char: char || null });
    this.clients.set(ws, { id, ack: 0 });
    return id;
  }

  // Returns true if the room is now empty and should be torn down immediately by the
  // caller (server.js) rather than waiting for its own countdown/grace period — a
  // room that nobody is in has no reason to keep occupying a slot in the manager.
  removeClient(ws) {
    const c = this.clients.get(ws); if (!c) return false;
    this.clients.delete(ws);
    if (this.phase === 'active') {
      this.world.remove(c.id);
      this.world.fill();
      this._broadcastRoster();
      return ![...this.world.bodies.values()].some(b => !b.isAI);
    }
    this.pending.delete(c.id);
    return this.pending.size === 0;
  }

  setInput(ws, seq, cmd) {
    const c = this.clients.get(ws); if (!c) return;
    c.ack = seq;
    this.world?.setInput(c.id, cmd);
  }

  // Public shape for the lobby-browser list (GET /api/lobbies) — solo rooms are
  // filtered out by RoomManager.list(), not here (this stays a plain data shape).
  summary() {
    return { id: this.id, phase: this.phase, count: this.pending.size, max: CFG.maxPlayers,
      countdownT: Math.max(0, Math.ceil(this.countdownT)) };
  }

  _lobbyPayload() {
    return { type: MSG.LOBBY, roomId: this.id, phase: this.phase,
      players: [...this.pending.entries()].map(([id, p]) => ({ id, name: p.name })),
      count: this.pending.size, max: CFG.maxPlayers, countdownT: Math.max(0, this.countdownT) };
  }
  _broadcastLobby() {
    const msg = JSON.stringify(this._lobbyPayload());
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
  _broadcastRoster() {
    const msg = JSON.stringify({ type: MSG.ROSTER, roster: this.world.roster() });
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }
  // ack is the only thing that varies per client this tick — everything else in
  // `snap` (every body, item, projectile, event) is identical for the whole room.
  // Re-running JSON.stringify on the full payload per client (as this used to)
  // reserializes that entire shared object once per connected player, every single
  // tick — wasted work that scales with both room size and world complexity. Doing
  // it once and splicing in each client's ack via cheap string concatenation instead
  // cuts that down to one real serialization per room per tick, however many players
  // are in it.
  _broadcastSnapshot() {
    const snap = this.world.snapshot();
    const snapJson = JSON.stringify(snap);
    const typeJson = JSON.stringify(MSG.SNAPSHOT);
    for (const [ws, c] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(`{"type":${typeJson},"s":${snapJson},"ack":${c.ack | 0}}`);
    }
  }
  _closeAllSockets() {
    for (const ws of this.clients.keys()) { try { ws.close(); } catch (e) {} }
  }

  _beginMatch() {
    this.world = new World();
    for (const [id, p] of this.pending) this.world.addPlayer(id, p.name, p.char);
    this.world.fill();
    this.phase = 'active';
    this._broadcastRoster();
  }

  // Called once per server tick for every room, regardless of phase.
  tick(dt, manager) {
    if (this.phase === 'waiting') {
      if (this.pending.size === 0) { this.countdownT = CFG.lobbyCountdown; return; }   // never counts down empty
      this.countdownT -= dt;
      if (this.pending.size >= CFG.maxPlayers || this.countdownT <= 0) {
        // startingT was already set correctly at construction (0 for a solo room,
        // CFG.lobbyStartBuffer otherwise) — a room only ever makes this transition
        // once, so it must NOT be reset here, or the solo bypass gets clobbered.
        this.phase = 'starting'; this._broadcastLobby();
      } else {
        this._lobbyBcT -= dt;
        if (this._lobbyBcT <= 0) { this._lobbyBcT = 1; this._broadcastLobby(); }
      }
      return;
    }
    if (this.phase === 'starting') {
      if (this.pending.size === 0) { manager.destroyRoom(this.id); return; }
      this.startingT -= dt;
      if (this.startingT <= 0) this._beginMatch();
      return;
    }
    // active
    this.world.step(dt);
    if (this.world.over) {
      this.resetTimer += dt;
      if (this.resetTimer > 6) { this._closeAllSockets(); manager.destroyRoom(this.id); return; }
    }
    this._broadcastSnapshot();
  }
}

export class RoomManager {
  constructor() { this.rooms = new Map(); }
  list() { return [...this.rooms.values()].filter(r => !r.solo && r.phase !== 'active').map(r => r.summary()); }
  findOpenRoom() { for (const r of this.rooms.values()) if (r.isJoinable()) return r; return null; }
  createRoom() { const r = new Room('r' + (nextRoomId++)); this.rooms.set(r.id, r); return r; }
  createSoloRoom() { const r = new Room('r' + (nextRoomId++), { solo: true }); this.rooms.set(r.id, r); return r; }
  getRoom(id) { return this.rooms.get(id); }
  destroyRoom(id) { this.rooms.delete(id); }
  // snapshot to an array first: a room's tick() can trigger destroyRoom() (its own or,
  // in principle, another's) mid-iteration — iterating a copy sidesteps ever having to
  // reason about mutating the live Map while walking it.
  tickAll(dt) { for (const r of [...this.rooms.values()]) r.tick(dt, this); }
}

export const roomManager = new RoomManager();
