// HTTP API: accounts, plus ONE game-wide default character. Reads are public (every
// player's client needs the model/animation files to render everyone the same way);
// writes are restricted to the admin account (the first account ever created).
// Structural changes (a new model, a new animation clip, switching to the sample rig)
// travel with a full settings snapshot (scale/yaw/tint/strip/assign) in the same
// request, so the DB row is always internally consistent.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Busboy from 'busboy';
import { stmt, UPLOAD_DIR } from './db.js';
import {
  hashPassword, verifyPassword, validEmail, validPassword,
  createSession, destroySession, currentUser, sessionCookie, clearCookie,
} from './auth.js';
import { applyMoveDurations, applyHitboxScale, applyGameConfig, currentGameConfig, applyMovesBalance, currentMovesBalance } from '../shared/constants.js';
import { SOUND_SLOTS } from '../shared/audio.js';
import { roomManager } from './rooms.js';

const MAX_FILE_BYTES = 150 * 1024 * 1024; // generous cap for rigged models w/ textures
const MAX_JSON_BYTES = 200 * 1024;
const DEFAULT_DIR = path.join(UPLOAD_DIR, 'default');

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Streams a multipart/form-data body: text fields into `fields`, at most one file
// straight to a temp path on disk (never buffered fully in memory). Waits for both
// busboy's own 'finish' AND the file's disk-write 'finish' before resolving — busboy
// can report done before the piped write actually completes.
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
    const fields = {}; let file = null, tooBig = false, settled = false;
    let bbFinished = false, fileSettled = true;
    const maybeDone = () => {
      if (settled || !bbFinished || !fileSettled) return; settled = true;
      tooBig ? reject(Object.assign(new Error('file too large'), { status: 413 })) : resolve({ fields, file });
    };
    const fail = e => { if (settled) return; settled = true; reject(e); };

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      fileSettled = false;
      const tmpPath = path.join(UPLOAD_DIR, 'tmp-' + crypto.randomBytes(16).toString('hex'));
      const out = fs.createWriteStream(tmpPath);
      stream.on('limit', () => { tooBig = true; stream.unpipe(out); out.destroy(); fs.unlink(tmpPath, () => {}); fileSettled = true; maybeDone(); });
      stream.pipe(out);
      out.on('finish', () => { if (!tooBig) file = { tmpPath, filename: info.filename || 'file' }; fileSettled = true; maybeDone(); });
      out.on('error', fail);
    });
    bb.on('error', fail);
    bb.on('finish', () => { bbFinished = true; maybeDone(); });
    req.pipe(bb);
  });
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
}
function ensureDefaultDir() { fs.mkdirSync(DEFAULT_DIR, { recursive: true }); return DEFAULT_DIR; }
function storeUpload(tmpPath, originalName) {
  const rel = path.join('default', crypto.randomBytes(8).toString('hex') + '-' + sanitizeName(originalName));
  fs.renameSync(tmpPath, path.join(UPLOAD_DIR, rel));
  return rel;
}
function unlinkQuiet(relOrAbs) {
  if (!relOrAbs) return;
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(UPLOAD_DIR, relOrAbs);
  fs.unlink(abs, () => {});
}
function parseDurations(d) {
  if (!d || typeof d !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  return out;
}
function parseSettings(raw, fallback) {
  let s; try { s = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { s = {}; }
  return {
    scale: Number.isFinite(s.scale) ? s.scale : fallback.scale,
    yaw: Number.isFinite(s.yaw) ? s.yaw : fallback.yaw,
    tint: (typeof s.tint === 'string' || s.tint === null) ? s.tint : fallback.tint,
    strip: typeof s.strip === 'boolean' ? s.strip : fallback.strip,
    assign: (s.assign && typeof s.assign === 'object') ? s.assign : fallback.assign,
    durations: s.durations !== undefined ? parseDurations(s.durations) : fallback.durations,
    // real on-screen size vs. a normal human (NOT the raw model-transform `scale`,
    // which is often just a unit-conversion fudge factor) — used to scale hit reach.
    // fallback may be a raw DB row (column `size_ratio`) or an already-parsed settings
    // object (`sizeRatio`) — read whichever is present, or better-sqlite3 will throw
    // trying to bind `undefined` as a parameter.
    sizeRatio: (typeof s.sizeRatio === 'number' && s.sizeRatio > 0) ? s.sizeRatio : (fallback.sizeRatio ?? fallback.size_ratio ?? 1),
    // vertical correction so a rig whose local origin isn't at its feet (common —
    // Mixamo puts it at the hips) doesn't render sunk into or floating above the floor
    groundOffset: (typeof s.groundOffset === 'number' && Number.isFinite(s.groundOffset)) ? s.groundOffset : (fallback.groundOffset ?? fallback.ground_offset ?? 0),
  };
}
const DEFAULT_SETTINGS = { scale: 1, yaw: 0, tint: null, strip: true, assign: {}, durations: {}, sizeRatio: 1, groundOffset: 0 };

// Public shape every client reads: per-slot volume + whether/what sample is assigned
// (the actual bytes are a separate GET so this stays small and cacheable-ish), plus
// the trim points (start/end, seconds into the sample — end:null means "no end trim").
function soundConfigPayload() {
  const bySlot = Object.fromEntries(stmt.allSoundSlots.all().map(r => [r.slot, r]));
  const out = {};
  for (const slot of SOUND_SLOTS) {
    const r = bySlot[slot];
    out[slot] = { volume: r ? r.volume : 1, hasSample: !!(r && r.stored_file), name: r ? r.orig_name : null,
      start: r ? r.trim_start : 0, end: r ? r.trim_end : null };
  }
  return out;
}

// No sign-in required — every one of the 11 call sites below only checks
// truthiness (`if (!user) return;`), never reads a property off the result, so
// this can stay a no-op stand-in rather than touching each call site.
function requireAdmin(req, res) {
  return { is_admin: 1 };
}

async function clearDefaultAnims() {
  for (const a of stmt.allDefaultAnims.all()) unlinkQuiet(a.stored_file);
  stmt.deleteAllDefaultAnims.run();
}

const routes = [
  ['POST', '/api/signup', async (req, res) => {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return json(res, 400, { error: 'invalid email' });
    if (!validPassword(body.password)) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (stmt.userByEmail.get(email)) return json(res, 409, { error: 'an account with that email already exists' });
    const isFirstUser = stmt.userCount.get().n === 0;
    const { hash, salt } = await hashPassword(body.password);
    const info = stmt.createUser.run(email, hash, salt, isFirstUser ? 1 : 0, Date.now());
    const token = createSession(info.lastInsertRowid);
    res.setHeader('Set-Cookie', sessionCookie(token, isSecure(req)));
    json(res, 201, { email, isAdmin: isFirstUser });
  }],

  ['POST', '/api/login', async (req, res) => {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = stmt.userByEmail.get(email);
    if (!user || !(await verifyPassword(String(body.password || ''), user.pass_hash, user.pass_salt)))
      return json(res, 401, { error: 'wrong email or password' });
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, isSecure(req)));
    json(res, 200, { email: user.email, isAdmin: !!user.is_admin });
  }],

  ['POST', '/api/logout', async (req, res) => {
    const user = currentUser(req);
    if (user) destroySession(user.sessionToken);
    res.setHeader('Set-Cookie', clearCookie(isSecure(req)));
    json(res, 200, { ok: true });
  }],

  ['GET', '/api/me', async (req, res) => {
    const user = currentUser(req);
    json(res, 200, user ? { email: user.email, isAdmin: !!user.is_admin } : { email: null, isAdmin: false });
  }],

  // public: every player's client needs this to render everyone with the same look
  ['GET', '/api/default-character', async (req, res) => {
    const row = stmt.getDefaultCharacter.get();
    const anims = stmt.allDefaultAnims.all().map(a => a.name);
    if (!row) return json(res, 200, { model: null, anims: [], ...DEFAULT_SETTINGS });
    const model = row.is_sample ? { kind: 'sample' } : (row.model_file ? { kind: 'file', name: row.model_name } : null);
    json(res, 200, {
      model, anims,
      scale: row.scale, yaw: row.yaw, tint: row.tint, strip: !!row.strip,
      assign: JSON.parse(row.assign || '{}'),
      durations: JSON.parse(row.durations || '{}'),
      sizeRatio: row.size_ratio,
      groundOffset: row.ground_offset,
    });
  }],

  ['GET', '/api/default-character/model-file', async (req, res) => {
    const row = stmt.getDefaultCharacter.get();
    if (!row || !row.model_file) return json(res, 404, { error: 'no default character set' });
    const abs = path.join(UPLOAD_DIR, row.model_file);
    fs.stat(abs, (err, st) => {
      if (err) return json(res, 404, { error: 'model file missing' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(row.model_name || 'model')}"`,
      });
      fs.createReadStream(abs).pipe(res);
    });
  }],

  ['GET', '/api/default-character/anim-file', async (req, res, url) => {
    const name = url.searchParams.get('name') || '';
    const row = stmt.defaultAnimByName.get(name);
    if (!row) return json(res, 404, { error: 'anim not found' });
    const abs = path.join(UPLOAD_DIR, row.stored_file);
    fs.stat(abs, (err, st) => {
      if (err) return json(res, 404, { error: 'anim file missing' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      });
      fs.createReadStream(abs).pipe(res);
    });
  }],

  ['POST', '/api/default-character/model', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const { fields, file } = await readMultipart(req);
    if (!file) return json(res, 400, { error: 'no file uploaded' });
    ensureDefaultDir();
    const existing = stmt.getDefaultCharacter.get();
    const settings = parseSettings(fields.settings, existing || DEFAULT_SETTINGS);
    let rel;
    try { rel = storeUpload(file.tmpPath, file.filename); }
    catch (e) { unlinkQuiet(file.tmpPath); throw e; }
    if (existing && existing.model_file) unlinkQuiet(existing.model_file);
    // Animation clips are a separate, independent asset from the model — swapping the
    // model no longer wipes them (compat() on the client flags bone-name mismatches
    // without deleting anything, so a still-compatible clip just keeps working).
    stmt.upsertDefaultCharacter.run({
      is_sample: 0, model_name: file.filename, model_file: rel,
      scale: settings.scale, yaw: settings.yaw, tint: settings.tint, strip: settings.strip ? 1 : 0,
      assign: JSON.stringify(settings.assign), durations: JSON.stringify(settings.durations),
      size_ratio: settings.sizeRatio, ground_offset: settings.groundOffset, updated_at: Date.now(),
    });
    applyMoveDurations(settings.durations);
    applyHitboxScale(settings.sizeRatio);
    json(res, 200, { ok: true });
  }],

  ['POST', '/api/default-character/sample', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const body = await readJson(req);
    const existing = stmt.getDefaultCharacter.get();
    const settings = parseSettings(body.settings, existing || DEFAULT_SETTINGS);
    if (existing && existing.model_file) unlinkQuiet(existing.model_file);
    // see the model-upload route above — anims outlive whatever model is loaded
    stmt.upsertDefaultCharacter.run({
      is_sample: 1, model_name: null, model_file: null,
      scale: settings.scale, yaw: settings.yaw, tint: settings.tint, strip: settings.strip ? 1 : 0,
      assign: JSON.stringify(settings.assign), durations: JSON.stringify(settings.durations),
      size_ratio: settings.sizeRatio, ground_offset: settings.groundOffset, updated_at: Date.now(),
    });
    applyMoveDurations(settings.durations);
    applyHitboxScale(settings.sizeRatio);
    json(res, 200, { ok: true });
  }],

  ['POST', '/api/default-character/anim', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const { fields, file } = await readMultipart(req);
    if (!file) return json(res, 400, { error: 'no file uploaded' });
    ensureDefaultDir();
    const existing = stmt.getDefaultCharacter.get();
    if (!existing) { unlinkQuiet(file.tmpPath); return json(res, 400, { error: 'load a model before adding animation clips' }); }
    const settings = parseSettings(fields.settings, existing);
    const prior = stmt.defaultAnimByName.get(file.filename);
    let rel;
    try { rel = storeUpload(file.tmpPath, file.filename); }
    catch (e) { unlinkQuiet(file.tmpPath); throw e; }
    if (prior) unlinkQuiet(prior.stored_file);
    stmt.upsertDefaultAnim.run(file.filename, rel);
    stmt.updateDefaultCharacterSettings.run({
      scale: settings.scale, yaw: settings.yaw, tint: settings.tint,
      strip: settings.strip ? 1 : 0, assign: JSON.stringify(settings.assign), durations: JSON.stringify(settings.durations),
      size_ratio: settings.sizeRatio, ground_offset: settings.groundOffset, updated_at: Date.now(),
    });
    applyMoveDurations(settings.durations);
    applyHitboxScale(settings.sizeRatio);
    json(res, 200, { ok: true });
  }],

  ['PATCH', '/api/default-character/settings', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const body = await readJson(req);
    const existing = stmt.getDefaultCharacter.get();
    const settings = parseSettings(body, existing || DEFAULT_SETTINGS);
    if (!existing) {
      stmt.upsertDefaultCharacter.run({
        is_sample: 0, model_name: null, model_file: null,
        scale: settings.scale, yaw: settings.yaw, tint: settings.tint, strip: settings.strip ? 1 : 0,
        assign: JSON.stringify(settings.assign), durations: JSON.stringify(settings.durations),
      size_ratio: settings.sizeRatio, ground_offset: settings.groundOffset, updated_at: Date.now(),
      });
    } else {
      stmt.updateDefaultCharacterSettings.run({
        scale: settings.scale, yaw: settings.yaw, tint: settings.tint,
        strip: settings.strip ? 1 : 0, assign: JSON.stringify(settings.assign), durations: JSON.stringify(settings.durations),
      size_ratio: settings.sizeRatio, ground_offset: settings.groundOffset, updated_at: Date.now(),
      });
    }
    applyMoveDurations(settings.durations);
    applyHitboxScale(settings.sizeRatio);
    json(res, 200, { ok: true });
  }],

  // Surgical: drops just the model (and any state→clip mapping that pointed at a clip
  // embedded IN it, since that clip no longer exists), so a heavy model can come down
  // before its replacement is ready. Leaves anim files, scale/tint/strip, and mappings
  // pointing at those separately-uploaded anims untouched — full-wipe below.
  ['DELETE', '/api/default-character/model', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const existing = stmt.getDefaultCharacter.get();
    if (!existing) return json(res, 200, { ok: true });
    if (existing.model_file) unlinkQuiet(existing.model_file);
    let assign; try { assign = JSON.parse(existing.assign || '{}'); } catch { assign = {}; }
    for (const st of Object.keys(assign)) if (assign[st] && assign[st].source === 'embedded') delete assign[st];
    stmt.upsertDefaultCharacter.run({
      is_sample: 0, model_name: null, model_file: null,
      scale: existing.scale, yaw: existing.yaw, tint: existing.tint, strip: existing.strip,
      assign: JSON.stringify(assign), durations: existing.durations,
      size_ratio: existing.size_ratio, ground_offset: existing.ground_offset, updated_at: Date.now(),
    });
    applyMoveDurations(JSON.parse(existing.durations || '{}'));
    applyHitboxScale(existing.size_ratio ?? 1);
    json(res, 200, { ok: true });
  }],

  ['DELETE', '/api/default-character', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const existing = stmt.getDefaultCharacter.get();
    if (existing && existing.model_file) unlinkQuiet(existing.model_file);
    await clearDefaultAnims();
    stmt.deleteDefaultCharacter.run();
    applyMoveDurations({});
    applyHitboxScale(1);
    json(res, 200, { ok: true });
  }],

  // Match balance (movement/input/zone/items/throw/superstar + per-move combat
  // balance) — public read (every client must apply the same values before a match
  // starts, since some feed shared/movement.js's stepBody(), which both client and
  // server run — see shared/constants.js's GAME_CONFIG_KEYS/MOVE_BALANCE_KEYS).
  // currentGameConfig()/currentMovesBalance() read the live CFG/MOVES, already loaded
  // from the DB at server startup, so this never needs its own separate DB read.
  ['GET', '/api/game-config', async (req, res) => { json(res, 200, { ...currentGameConfig(), moves: currentMovesBalance() }); }],

  ['PATCH', '/api/game-config', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const body = await readJson(req);
    const cfg = applyGameConfig(body);
    const moves = applyMovesBalance(body.moves || {});
    const combined = { ...cfg, moves };
    stmt.upsertGameConfig.run({ data: JSON.stringify(combined), updated_at: Date.now() });
    json(res, 200, combined);
  }],

  // Lobby browser: public read of every joinable room (waiting/starting — an 'active'
  // room has nothing left to join, so it's omitted; see server/rooms.js's
  // RoomManager.list()). No write route — rooms are created/joined only via the
  // WebSocket JOIN message, never through this REST API.
  ['GET', '/api/lobbies', async (req, res) => { json(res, 200, { rooms: roomManager.list() }); }],

  // Audio mixer (shared/audio.js's SOUND_SLOTS): public read (every client needs the
  // volume + sample to actually play the cue), admin-only write, same split as the
  // default character / match balance above.
  ['GET', '/api/sound-config', async (req, res) => { json(res, 200, soundConfigPayload()); }],

  ['GET', '/api/sound-file', async (req, res, url) => {
    const slot = url.searchParams.get('slot') || '';
    if (!SOUND_SLOTS.includes(slot)) return json(res, 404, { error: 'unknown sound slot' });
    const row = stmt.soundSlotByName.get(slot);
    if (!row || !row.stored_file) return json(res, 404, { error: 'no sample assigned' });
    const abs = path.join(UPLOAD_DIR, row.stored_file);
    fs.stat(abs, (err, st) => {
      if (err) return json(res, 404, { error: 'sample file missing' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(row.orig_name || slot)}"`,
      });
      fs.createReadStream(abs).pipe(res);
    });
  }],

  ['PATCH', '/api/sound-config', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const body = await readJson(req);
    for (const slot of SOUND_SLOTS) {
      const e = body[slot]; if (!e) continue;
      const v = e.volume;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const volume = Math.max(0, Math.min(1, v));
      // trim (start/end, seconds into the sample — see the Studio's Audio Mixer knobs):
      // start clamps to >=0; end is only kept if it's a real number strictly after
      // start, otherwise NULL ("no end trim, play to the sample's own natural end") —
      // same validate-or-fall-back-to-a-sane-default shape as every other admin input.
      const trimStart = (typeof e.start === 'number' && Number.isFinite(e.start) && e.start >= 0) ? e.start : 0;
      const trimEnd = (typeof e.end === 'number' && Number.isFinite(e.end) && e.end > trimStart) ? e.end : null;
      stmt.upsertSoundVolume.run({ slot, volume, trimStart, trimEnd });
    }
    json(res, 200, soundConfigPayload());
  }],

  ['POST', '/api/sound-sample', async (req, res) => {
    const user = requireAdmin(req, res); if (!user) return;
    const { fields, file } = await readMultipart(req);
    const slot = fields.slot || '';
    if (!SOUND_SLOTS.includes(slot)) { if (file) unlinkQuiet(file.tmpPath); return json(res, 400, { error: 'unknown sound slot' }); }
    if (!file) return json(res, 400, { error: 'no file uploaded' });
    ensureDefaultDir();
    const prior = stmt.soundSlotByName.get(slot);
    let rel;
    try { rel = storeUpload(file.tmpPath, file.filename); }
    catch (e) { unlinkQuiet(file.tmpPath); throw e; }
    if (prior && prior.stored_file) unlinkQuiet(prior.stored_file);
    stmt.upsertSoundSample.run(slot, rel, file.filename);
    json(res, 200, soundConfigPayload());
  }],

  ['DELETE', '/api/sound-sample', async (req, res, url) => {
    const user = requireAdmin(req, res); if (!user) return;
    const slot = url.searchParams.get('slot') || '';
    if (!SOUND_SLOTS.includes(slot)) return json(res, 400, { error: 'unknown sound slot' });
    const prior = stmt.soundSlotByName.get(slot);
    if (prior && prior.stored_file) unlinkQuiet(prior.stored_file);
    stmt.clearSoundSample.run(slot);
    json(res, 200, soundConfigPayload());
  }],
];

function isSecure(req) {
  return req.socket.encrypted === true || req.headers['x-forwarded-proto'] === 'https';
}

export async function handleApi(req, res, pathname) {
  const url = new URL(req.url, 'http://internal');
  const route = routes.find(([m, p]) => m === req.method && p === pathname);
  if (!route) { json(res, 404, { error: 'not found' }); return; }
  try { await route[2](req, res, url); }
  catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    else res.end();
  }
}
