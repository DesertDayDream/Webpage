// Persistent storage: accounts, plus ONE game-wide default character that only the
// admin account can edit via the Studio — every player (signed in or not) renders
// using it. SQLite holds metadata; the actual model/animation binaries live on disk
// next to it (referenced by stored filename), since they can be tens of MB each.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Points into the Webpage project's own data/ folder (already covered by its
// Railway persistent volume — see mount.js) instead of a slam-royale-local data/
// folder, so the admin's uploaded character/sounds survive redeploys the same way
// Webpage's own site.db and uploads/ already do. __dirname here is
// <webpage-root>/slam-royale/server, so two levels up reaches <webpage-root>.
export const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'slam-royale');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Sweep any 'tmp-*' files left behind by an upload that never finished (e.g. a
// write that failed partway through — server/api.js's readMultipart() now
// cleans these up itself when that happens, but this covers whatever's already
// sitting here from before that fix, and any other way a temp file could be
// orphaned (a killed process mid-upload, etc.). These are always fully-internal
// temp names (never referenced by any DB row), so anything matching is safe to
// remove unconditionally.
for (const name of fs.readdirSync(UPLOAD_DIR)) {
  if (name.startsWith('tmp-')) fs.unlink(path.join(UPLOAD_DIR, name), () => {});
}

export const db = new Database(path.join(DATA_DIR, 'slam-royale.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS default_character (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_sample INTEGER NOT NULL DEFAULT 0,
    model_name TEXT,
    model_file TEXT,
    scale REAL NOT NULL DEFAULT 1,
    yaw REAL NOT NULL DEFAULT 0,
    tint TEXT,
    strip INTEGER NOT NULL DEFAULT 1,
    assign TEXT NOT NULL DEFAULT '{}',
    durations TEXT NOT NULL DEFAULT '{}',
    size_ratio REAL NOT NULL DEFAULT 1,
    ground_offset REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS default_character_anims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    stored_file TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sound_slots (
    slot TEXT PRIMARY KEY,
    volume REAL NOT NULL DEFAULT 1,
    stored_file TEXT,
    orig_name TEXT,
    trim_start REAL NOT NULL DEFAULT 0,
    trim_end REAL
  );
`);

// migration: columns added after default_character/sound_slots already existed in the
// wild — CREATE TABLE IF NOT EXISTS above doesn't retrofit new columns onto an
// existing table.
{
  const cols = db.prepare("PRAGMA table_info(default_character)").all().map(c => c.name);
  if (!cols.includes('size_ratio')) db.exec('ALTER TABLE default_character ADD COLUMN size_ratio REAL NOT NULL DEFAULT 1');
  if (!cols.includes('ground_offset')) db.exec('ALTER TABLE default_character ADD COLUMN ground_offset REAL NOT NULL DEFAULT 0');
}
{
  // trim_end is nullable by design (NULL = "no end trim, play to the sample's own
  // natural end") — that's why it has no DEFAULT the way trim_start does.
  const cols = db.prepare("PRAGMA table_info(sound_slots)").all().map(c => c.name);
  if (!cols.includes('trim_start')) db.exec('ALTER TABLE sound_slots ADD COLUMN trim_start REAL NOT NULL DEFAULT 0');
  if (!cols.includes('trim_end')) db.exec('ALTER TABLE sound_slots ADD COLUMN trim_end REAL');
}

export const stmt = {
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  createUser: db.prepare('INSERT INTO users (email, pass_hash, pass_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),

  createSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  getDefaultCharacter: db.prepare('SELECT * FROM default_character WHERE id = 1'),
  upsertDefaultCharacter: db.prepare(`
    INSERT INTO default_character (id, is_sample, model_name, model_file, scale, yaw, tint, strip, assign, durations, size_ratio, ground_offset, updated_at)
    VALUES (1, @is_sample, @model_name, @model_file, @scale, @yaw, @tint, @strip, @assign, @durations, @size_ratio, @ground_offset, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      is_sample=excluded.is_sample, model_name=excluded.model_name, model_file=excluded.model_file,
      scale=excluded.scale, yaw=excluded.yaw, tint=excluded.tint, strip=excluded.strip,
      assign=excluded.assign, durations=excluded.durations, size_ratio=excluded.size_ratio,
      ground_offset=excluded.ground_offset, updated_at=excluded.updated_at
  `),
  updateDefaultCharacterSettings: db.prepare(`
    UPDATE default_character SET scale=@scale, yaw=@yaw, tint=@tint, strip=@strip, assign=@assign, durations=@durations,
      size_ratio=@size_ratio, ground_offset=@ground_offset, updated_at=@updated_at
    WHERE id = 1
  `),
  deleteDefaultCharacter: db.prepare('DELETE FROM default_character WHERE id = 1'),

  allDefaultAnims: db.prepare('SELECT * FROM default_character_anims'),
  defaultAnimByName: db.prepare('SELECT * FROM default_character_anims WHERE name = ?'),
  upsertDefaultAnim: db.prepare(`
    INSERT INTO default_character_anims (name, stored_file) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET stored_file=excluded.stored_file
  `),
  deleteAllDefaultAnims: db.prepare('DELETE FROM default_character_anims'),

  getGameConfig: db.prepare('SELECT * FROM game_config WHERE id = 1'),
  upsertGameConfig: db.prepare(`
    INSERT INTO game_config (id, data, updated_at) VALUES (1, @data, @updated_at)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
  `),

  allSoundSlots: db.prepare('SELECT * FROM sound_slots'),
  soundSlotByName: db.prepare('SELECT * FROM sound_slots WHERE slot = ?'),
  upsertSoundVolume: db.prepare(`
    INSERT INTO sound_slots (slot, volume, trim_start, trim_end) VALUES (@slot, @volume, @trimStart, @trimEnd)
    ON CONFLICT(slot) DO UPDATE SET volume=excluded.volume, trim_start=excluded.trim_start, trim_end=excluded.trim_end
  `),
  // Trim points reset to "untrimmed" on a fresh upload — old start/end points were
  // measured against whatever sample used to be in this slot, and have no meaningful
  // relationship to a brand new file's own length/content.
  upsertSoundSample: db.prepare(`
    INSERT INTO sound_slots (slot, volume, stored_file, orig_name, trim_start, trim_end) VALUES (?, 1, ?, ?, 0, NULL)
    ON CONFLICT(slot) DO UPDATE SET stored_file=excluded.stored_file, orig_name=excluded.orig_name, trim_start=0, trim_end=NULL
  `),
  clearSoundSample: db.prepare('UPDATE sound_slots SET stored_file=NULL, orig_name=NULL WHERE slot=?'),
};
