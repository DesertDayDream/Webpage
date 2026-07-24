// Shared by server (authority) and client (prediction). Pure data — no Node/DOM.

export const NET = {
  FIXED_DT: 1 / 60,   // simulation + input step (seconds). Client & server MUST match.
  INTERP_MS: 100,     // render remote players this far in the past (jitter smoothing)
};

export const CFG = {
  // Arena-brawler feel: fast accel with little wind-up, snappier decel so stops feel
  // crisp, tight turning even at full speed, heavy-but-controllable jumps. accel/decel/
  // turn are exponential-smoothing rates (1/time-constant), not literal m/s²/°s — tuned
  // to feel equivalent to ~50/60 m/s² and ~1000°/s respectively.
  gravity: -20, jumpSpeed: 8.5, maxFallSpeed: 30,
  walk: 6.0, run: 11.0, accel: 20, decel: 26, turn: 22, airControl: 0.75,
  maxPlayers: 8, spawnRadius: 20,
  // Lobby (server/rooms.js): a room accumulates joining players in a 'waiting' phase
  // until EITHER it hits maxPlayers OR this countdown runs out, whichever comes
  // first, then moves to 'starting' for lobbyStartBuffer seconds (giving clients time
  // to load character assets) before the match actually begins ticking.
  lobbyCountdown: 20, lobbyStartBuffer: 3,
  // Battle countdown: once the match world actually exists (everyone loaded in — see
  // server/world.js's step()), a final frozen "3, 2, 1" beat before anyone can move
  // or act at all — server-authoritative (not just a client overlay drawn on top of
  // an already-ticking match) so it's the same for every player and nobody can get a
  // head start during it.
  battleCountdown: 3,
  // health/stamina pools + regen. stamRegen is per-second, checked each tick in
  // shared/movement.js's stepBody() — 0 disables regen entirely (stamina then only
  // ever goes down, e.g. from dodging or attacking, until the round ends or something
  // else refills it). stamRegenDelay: seconds after stamina was last SPENT before
  // regen resumes — resets on every spend, so continuing to act keeps pushing regen
  // off, same "winded" feel as most stamina systems. stamRegenBlockMult: this pool's
  // regen is multiplied by this while holding block (and the delay above has elapsed)
  // — a reward for turtling instead of mashing. Blocking itself no longer spends from
  // THIS pool at all — see maxBlockStam below, a separate pool dedicated to blocking.
  maxHp: 100, maxStam: 100, stamRegen: 22, stamRegenDelay: 1.0, stamRegenBlockMult: 2.0,
  // Sprint (Shift) drains this same pool while actually moving at run speed — falls
  // back to walk speed on its own once stamina's exhausted (same "can't do this
  // forever" shape as block stamina), same delay-then-regen as every other spend.
  sprintStamDrain: 10,
  // block stamina: a pool dedicated to holding block, separate from the one above (so
  // turtling doesn't compete with your ability to attack/dodge right after) — drains
  // passively while block is held (guard silently drops once empty — no stagger, just
  // "out of breath") AND extra per absorbed hit, scaled by the attacker's own move
  // (see MOVES[x].blockStam above, checked in server/world.js's applyHit() — heavier
  // moves cost more to block) — draining it to 0 THAT way is the harsher guard-break
  // case (still staggers, same as before this pool existed). Regens like normal
  // stamina (same delay-then-rate shape) once you're not actively blocking.
  maxBlockStam: 100, blockStamDrain: 15, blockStamRegen: 18, blockStamRegenDelay: 1.0,
  // sandbox: true strips the match down to just the world itself — no AI backfill, no
  // "last one standing" end condition. Flip back to false to restore the normal
  // 8-player battle royale. See server/world.js for the gates. There's no shrinking/
  // damaging storm anymore either way — zoneR0 is just the fixed arena/spawn radius
  // AI stays within, not a zone that closes in.
  sandbox: true,
  zoneR0: 38,
  fighterRadius: 0.4,                            // for fighter-vs-fighter push-apart collision
  hitstopHit: 0.08, hitstopHeavy: 0.12, hitstopBlock: 0.05, hitstopGrab: 0.15,
  // Clash: two fighters throwing the IDENTICAL move at each other, both landing in
  // the same tick, cancel out instead of one silently winning — see server/world.js's
  // resolveHits(). Neither side takes damage or "loses"; the stagger duration tracks
  // the mapped "clash" clip's real length instead of living here (see
  // CLASH_STAGGER_DUR/applyClashStaggerDuration() below, same pattern as DODGE_DUR).
  // clashKbMult scales each move's own knockback for the push-apart, and hitstopClash
  // is a punchier freeze than a normal hit for the "clang" weight.
  clashKbMult: 0.5, hitstopClash: 0.18,
  // Stun (see shared/movement.js): 0 = use the mapped "stunned" clip's own real
  // length (or the 1.2s default if none is mapped) — set above 0 to override it
  // outright, e.g. to hold a looping "dizzy idle" clip for longer than its own
  // natural length (see STUN_CLIP_DUR/recomputeStunDur() below).
  stunDuration: 0,
  // A hard debounce on light1/2/3, separate from stamina/cancel-window timing: without
  // it, holding a key down triggers the browser's own keyboard auto-repeat (OS-level,
  // ~20-30 presses/sec), which reads as mashing and refires a light attack every time
  // the gate reopens — indistinguishable from a genuinely fast player. Each of the 3
  // tracks its OWN cooldown independently (see shared/movement.js) — firing light1
  // only debounces light1, so a press against a DIFFERENT light move right after still
  // goes through; a press against a move still on ITS cooldown is ignored outright
  // (not queued for later).
  lightInputCooldown: 0.15,

  // ---- grab ("Vicious attack" — hold heavy past this to grab instead of tapping) ----
  grabHoldThreshold: 0.35,

  // ---- dodge (C) — rebuilt: i-frames for the first ~70% of the dodge (dodgeIframeFrac) ----
  dodgeSpeed: 9, dodgeStam: 30, dodgeIframeFrac: 0.7,

  // ---- items: aim (Q) / throw (E) — replaces the old dodge/slam bindings ----
  itemCount: 4, itemPickupRadius: 1.2, itemRespawn: 15,       // scattered throwable pickups
  aimSpeedMult: 0.5,                                          // holding Q (aiming) slows you
  throwDur: 0.3,                                              // brief lock while releasing the throw
  throwSpeed: 16, throwUpSpeed: 5, throwLife: 3,               // projectile: horizontal/vertical launch speed, max lifetime (s)
  // How much camera pitch (looking up/down while aiming) adjusts the projectile's
  // vertical launch speed on top of throwUpSpeed above — see server/world.js's throw
  // spawn (note it's SUBTRACTED there, not added — render.js's Cam tracks pitch as the
  // camera's own orbit elevation, the opposite sign from the player's perceived look
  // direction) and shared/movement.js's b.aimPitch. Net effect either way: looking up
  // adds hang time (farther, higher arc), looking down subtracts it (flatter, shorter).
  throwPitchInfluence: 10,
  throwDmg: 18, throwKb: 6, throwHitRadius: 0.6,

  // ---- superstar mode (R) ----
  superstarMax: 100,
  superstarPerDmgDealt: 0.6, superstarPerDmgTaken: 0.4,       // meter gained per HP of damage dealt/taken
  orbCount: 3, orbPickupRadius: 1.2, orbRespawn: 20, orbGain: 25,  // scattered meter-only pickups
  superstarDuration: 12,
  superstarDmgMult: 1.5, superstarSpeedMult: 1.25, superstarHeavyMult: 1.9,  // stat buffs while active
};

// move → { dur, active window a0..a1 (0..1), reach, front arc(dot), dmg, knockback, stamina, victim hitstun }
// a0/a1 windows are deliberately wide (roughly the middle 40-45% of the move) rather
// than a narrow sliver — they were originally tuned tight against the built-in
// procedural animation's exact timing, but a custom clip's real "impact" instant can
// land anywhere in that range, so a wide window is what actually keeps hits landing
// where the swing visually connects instead of whiffing through a target.
// lunge: peak forward speed (units/s) the move drives the fighter at during its own
// active window, independent of WASD — see shared/movement.js's lungeTarget(). Ramps
// up through a0 (wind-up), holds through a0..a1 (the same active window hit detection
// already uses), eases back down through a1..1 (recovery). 0 = no forward displacement
// of its own (light attacks keep whatever velocity carried in, same as before).
// speedMult: playback-speed multiplier (1 = normal). Scales the move's actual dur (and
// therefore its hit-active window and lunge curve, both stored as fractions of dur) in
// lockstep with the animation — a "faster" move really is faster, gameplay included,
// rather than the visual clip outrunning or lagging the hit timing. See
// recomputeMoveDur() below.
// grab ("Vicious attack"): unblockable — resolveHits()/applyHit() in server/world.js
// skip the block-reduction branch entirely when def.unblockable is set, so it deals
// full damage/knockback regardless of the target's guard. Its counterplay isn't block,
// it's timing: a0 is deliberately late (a long "startup" before grab is dur*0.30) is
// where nothing has happened yet — any strike or dodge that reaches the grabber during
// that window interrupts it via the ordinary stagger/i-frame paths (see shared/
// movement.js and server/world.js's resolveHits), no special-case "counter" code
// needed. Triggered by holding heavy (F) past CFG.grabHoldThreshold instead of
// tapping it — see stepBody's heavyHoldT tracking.
// blockStam: how much of the DEFENDER's block-stamina pool (see CFG.maxBlockStam
// below, checked/spent in server/world.js's applyHit()) absorbing this move while
// blocking costs — separate from `stam`, which is what the move costs its own
// ATTACKER to throw. Heavier moves cost more to block, same "can't turtle forever"
// idea as the passive block-stamina drain in shared/movement.js's stepBody().
export const MOVES = {
  light1: { dur:.40, a0:.20, a1:.60, range:1.9, arc:.30, dmg:9,  kb:3.4, stam:7,  hit:.30, lunge:0, speedMult:1, blockStam:12 },
  light2: { dur:.40, a0:.20, a1:.60, range:1.9, arc:.30, dmg:9,  kb:3.4, stam:7,  hit:.30, lunge:0, speedMult:1, blockStam:12 },
  light3: { dur:.52, a0:.22, a1:.65, range:2.0, arc:.25, dmg:14, kb:6.5, stam:10, hit:.42, lunge:0, speedMult:1, blockStam:16 },
  heavy:  { dur:.64, a0:.30, a1:.75, range:2.1, arc:.18, dmg:21, kb:8.0, stam:24, hit:.52, lunge:7, speedMult:1, blockStam:30 },
  grab:   { dur:.90, a0:.42, a1:.70, range:1.7, arc:.25, dmg:30, kb:12,  stam:30, hit:.90, lunge:5, speedMult:1, unblockable:true, blockStam:30 },
  // superAttack ("Star Slam" — press R/T again while superstar mode is already active):
  // unblockable AND oneShot (server/world.js's applyHit() forces the target's hp to 0
  // outright when oneShot is set, instead of the usual dmg formula — dmg here is just
  // a sane fallback, never actually what kills). Committing to it immediately ends the
  // superstar buff (see shared/movement.js) — one guaranteed kill per full meter, not
  // a repeatable one-shot machine gun for the rest of the buff's duration. Being an
  // ordinary MOVES entry (and isAtk() below) means it gets everything every other move
  // already has for free: clip-length dur/hit-reaction sync, hitbox scaling, dodge
  // i-frames as real counterplay, admin tuning, and — since two fighters throwing the
  // identical move at each other is already a clash (see resolveHits()) — two mutual
  // superAttacks cancel out instead of double-KOing each other, with no extra code.
  // stam:0 — deliberately free. You already paid for it with a full meter; gating it
  // on the regular stamina pool too would let a badly-timed light attack right before
  // starve out a kill you already earned.
  superAttack: { dur:.85, a0:.35, a1:.75, range:2.2, arc:.18, dmg:999, kb:10, stam:0, hit:.6, lunge:6, speedMult:1, unblockable:true, oneShot:true, blockStam:50 },
};

export const isAtk = a => a==='light1'||a==='light2'||a==='light3'||a==='heavy'||a==='grab'||a==='superAttack';

// The durations/ranges above assume the built-in procedural rig at its natural size.
// When the admin's default character maps a real clip onto one of these states, or
// resizes the model, both get overridden to track the actual character — see
// applyMoveDurations()/applyHitboxScale(), called by both the server (authority) and
// every client (prediction) whenever the default character changes, so the two stay
// identical (required for prediction/reconciliation to agree).
const DEFAULT_MOVE_DUR = Object.fromEntries(Object.entries(MOVES).map(([k,v])=>[k,v.dur]));
const DEFAULT_RANGE = Object.fromEntries(Object.entries(MOVES).map(([k,v])=>[k,v.range]));
const DEFAULT_HIT_DUR = Object.fromEntries(Object.entries(MOVES).map(([k,v])=>[k,v.hit]));
const HIT_REFERENCE = DEFAULT_HIT_DUR.light1;   // baseline light1's default hitstun is scaled against
const DEFAULT_DEAD_DUR = 3;
export let DEAD_DUR = DEFAULT_DEAD_DUR;
const DEFAULT_DODGE_DUR = 0.42;
export let DODGE_DUR = DEFAULT_DODGE_DUR;
const DEFAULT_CLASH_STAGGER = 0.35;
export let CLASH_STAGGER_DUR = DEFAULT_CLASH_STAGGER;
const DEFAULT_STUN_DUR = 1.2;
// Stun's actual duration is whichever of two inputs is active: CFG.stunDuration (an
// admin-typed override, GAME_CONFIG_KEYS below) if set above 0, otherwise the mapped
// "stunned" clip's own real length (STUN_CLIP_DUR, set by applyStunDuration() — see
// its comment). The override exists specifically so a LOOPING clip (stunned is a
// looping state — see client/character.js's LOOPING set) like a "dizzy idle" can be
// held for LONGER than its own natural length, repeating seamlessly to fill
// whatever duration is configured, rather than the duration always being capped to
// exactly the clip's own length the way dodge/clash/dead's are.
let STUN_CLIP_DUR = DEFAULT_STUN_DUR;
export let STUN_DUR = DEFAULT_STUN_DUR;
export function recomputeStunDur(){
  STUN_DUR = (CFG.stunDuration>0) ? CFG.stunDuration : STUN_CLIP_DUR;
}
// "grabbed" (being thrown) is its own clip slot, separate from the generic "hit"
// flinch — but used to borrow MOVES.grab.hit for its held duration, which only
// tracks the mapped "hit" clip's length (scaled proportionally, see
// applyHitReactionDuration() below), not whatever "grabbed" clip is actually mapped.
// A grab animation and a differently-timed grabbed reaction easily drift out of sync
// as a result — same class of bug dodge/clash/dead's own dedicated durations already
// solved. Tracked independently here instead, same pattern as those three.
const DEFAULT_GRABBED_DUR = DEFAULT_HIT_DUR.grab;
export let GRABBED_DUR = DEFAULT_GRABBED_DUR;
export function applyGrabbedDuration(dur){
  GRABBED_DUR = (typeof dur==='number' && dur>0) ? dur : DEFAULT_GRABBED_DUR;
}
// The clip-length-driven duration, BEFORE speedMult is applied — applyMoveDurations()
// updates this; MOVES[k].dur (what gameplay actually reads) is always
// BASE_MOVE_DUR[k]/speedMult, recomputed by recomputeMoveDur() whenever either input
// changes (from here or from applyMovesBalance() setting a new speedMult).
const BASE_MOVE_DUR = { ...DEFAULT_MOVE_DUR };
function recomputeMoveDur(){
  for(const k of Object.keys(MOVES)) MOVES[k].dur = BASE_MOVE_DUR[k]/MOVES[k].speedMult;
}

export function applyMoveDurations(overrides={}){
  for(const k of Object.keys(MOVES)){
    const d = overrides[k];
    BASE_MOVE_DUR[k] = (typeof d==='number' && d>0) ? d : DEFAULT_MOVE_DUR[k];
  }
  recomputeMoveDur();
  applyHitReactionDuration(overrides.hit);
  applyDeadDuration(overrides.dead);
  applyDodgeDuration(overrides.dodge);
  applyClashStaggerDuration(overrides.clash);
  applyStunDuration(overrides.stun);
  applyGrabbedDuration(overrides.grabbed);
}

// Dodge's held duration — no per-move variation to preserve (it's not in MOVES, same
// reasoning as dead), just a single global value tracking whatever "dodge" clip is
// mapped, or the 0.42s default.
export function applyDodgeDuration(dur){
  DODGE_DUR = (typeof dur==='number' && dur>0) ? dur : DEFAULT_DODGE_DUR;
}

// Clash's stagger, same idea as dodge's: the stun should last exactly as long as
// whatever "clash" clip is mapped (both fighters play it, so there's only one length
// to track, not per-move variation) — 0.35s default when none is mapped/using the
// procedural rig. Deliberately NOT a plain admin-typed CFG number (like it started
// out as) for the same reason dodge/dead aren't: a hand-typed duration could drift
// from the actual clip length, and a mismatch there is exactly the kind of
// animation/logic desync bug this game has already hit once this session.
export function applyClashStaggerDuration(dur){
  CLASH_STAGGER_DUR = (typeof dur==='number' && dur>0) ? dur : DEFAULT_CLASH_STAGGER;
}

// Stun's held duration — triggered when either stamina pool (regular or block, see
// shared/movement.js's stepBody()) is drained to 0. Unlike dodge/clash above, this
// one DOES have an admin-typed override on top of the clip-length default (see
// CFG.stunDuration / recomputeStunDur() above) — safe here specifically because
// stunned is a LOOPING state, so a duration longer than the clip just repeats it
// seamlessly instead of freezing on a held last frame the way a one-shot clip would.
export function applyStunDuration(dur){
  STUN_CLIP_DUR = (typeof dur==='number' && dur>0) ? dur : DEFAULT_STUN_DUR;
  recomputeStunDur();
}

// There's only one "hit" reaction clip slot (not one per move), so a mapped clip's
// real length can't replace each move's hitstun independently the way dur/range do —
// instead it scales all of them proportionally against light1's default hitstun,
// preserving the existing balance (heavy still staggers longer than light1) while
// still tracking the actual clip length.
export function applyHitReactionDuration(clipDur){
  const scale = (typeof clipDur==='number' && clipDur>0) ? clipDur/HIT_REFERENCE : 1;
  for(const k of Object.keys(MOVES)) MOVES[k].hit = DEFAULT_HIT_DUR[k]*scale;
}

// The death pose's held duration — no per-move variation to preserve here, just a
// single global value that tracks whatever "dead" clip is mapped, or the 3s default.
export function applyDeadDuration(dur){
  DEAD_DUR = (typeof dur==='number' && dur>0) ? dur : DEFAULT_DEAD_DUR;
}

// A bigger/smaller character should reach proportionally farther/less far — scale
// every move's hit range by the character's model scale (arc is an angle, unaffected).
export function applyHitboxScale(scale){
  const s = (typeof scale==='number' && scale>0) ? scale : 1;
  for(const k of Object.keys(MOVES)) MOVES[k].range = DEFAULT_RANGE[k]*s;
}

export const MSG = { JOIN:'join', WELCOME:'welcome', INPUT:'input', SNAPSHOT:'snap', ROSTER:'roster',
  LOBBY:'lobby', JOIN_REJECTED:'joinRejected' };

// ---- admin-tunable match balance (items/throw/superstar) — see server/api.js's
// /api/game-config routes and client/studio.js's "Match Balance" panel. Persisted in
// the DB and loaded once at server startup, then pushed to each client right before a
// match starts (client/main.js's enterMatch()) — some of these (aimSpeedMult, throwDur,
// ...) feed shared/movement.js's stepBody(), which client and server both run, so both
// sides must agree on the same values or prediction/reconciliation would fight itself.
export const GAME_CONFIG_KEYS = [
  // movement/physics
  'gravity','jumpSpeed','maxFallSpeed','walk','run','accel','decel','turn','airControl',
  // lobby
  'lobbyCountdown','lobbyStartBuffer','battleCountdown',
  // health/stamina
  'maxHp','maxStam','stamRegen','stamRegenDelay','stamRegenBlockMult','sprintStamDrain',
  'maxBlockStam','blockStamDrain','blockStamRegen','blockStamRegenDelay',
  // input timing
  'hitstopHit','hitstopHeavy','hitstopBlock','hitstopGrab','lightInputCooldown',
  'clashKbMult','hitstopClash','stunDuration',
  // grab (hold heavy) / dodge (C)
  'grabHoldThreshold','dodgeSpeed','dodgeStam','dodgeIframeFrac',
  // battle royale / zone
  'maxPlayers','spawnRadius','sandbox','zoneR0','fighterRadius',
  // items: aim (Q) / throw (E)
  'itemCount','itemPickupRadius','itemRespawn','aimSpeedMult',
  'throwDur','throwSpeed','throwUpSpeed','throwLife','throwDmg','throwKb','throwHitRadius','throwPitchInfluence',
  // superstar mode (R)
  'superstarMax','superstarPerDmgDealt','superstarPerDmgTaken',
  'orbCount','orbPickupRadius','orbRespawn','orbGain',
  'superstarDuration','superstarDmgMult','superstarSpeedMult','superstarHeavyMult',
];
const DEFAULT_GAME_CFG = Object.fromEntries(GAME_CONFIG_KEYS.map(k=>[k,CFG[k]]));
const INT_KEYS = new Set(['itemCount','orbCount','maxPlayers']);
const ALLOW_NEGATIVE_KEYS = new Set(['gravity']);   // a downward acceleration, stored negative by convention — everything else here is a magnitude/duration/multiplier

export function currentGameConfig(){ return Object.fromEntries(GAME_CONFIG_KEYS.map(k=>[k,CFG[k]])); }

// Validates + applies onto the live CFG (falling back to the hardcoded default for
// anything missing/invalid), and returns the resulting validated object — the one
// place this validation logic lives, used both to apply an update and to compute what
// gets persisted (see server/api.js's PATCH handler). Type-aware per key (only
// `sandbox` is boolean; everything else here is numeric) — checked against
// DEFAULT_GAME_CFG's own type rather than a separate hardcoded list.
export function applyGameConfig(overrides={}){
  for(const k of GAME_CONFIG_KEYS){
    const def = DEFAULT_GAME_CFG[k], v = overrides[k];
    if (typeof def === 'boolean'){ CFG[k] = (typeof v === 'boolean') ? v : def; continue; }
    const okSign = ALLOW_NEGATIVE_KEYS.has(k) ? true : v>=0;
    CFG[k] = (typeof v==='number' && Number.isFinite(v) && okSign) ? v : def;
    if (INT_KEYS.has(k)) CFG[k] = Math.round(CFG[k]);
  }
  recomputeStunDur();   // CFG.stunDuration may have just changed — see its own comment above
  return currentGameConfig();
}

// ---- combat balance (MOVES table) — deliberately excludes `dur`, `range`, and `hit`,
// which already have a correct, separate override mechanism driven by the admin's
// character (clip length / model size / hit-reaction clip length — see
// applyMoveDurations()/applyHitboxScale()/applyHitReactionDuration() below). A second
// competing override path for those same fields would just fight that one —
// everything else about a move (timing window, arc, damage, knockback, stamina cost,
// lunge, and now playback speed) has no such conflict and is fair game here.
// speedMult is included but handled specially below: unlike the others it isn't a
// standalone value, it feeds recomputeMoveDur() (see above `dur` is BASE_MOVE_DUR
// divided by this), so it must stay strictly positive — 0 or negative would produce
// an infinite or backwards-flowing duration.
export const MOVE_BALANCE_KEYS = ['a0','a1','arc','dmg','kb','stam','blockStam','lunge','speedMult'];
const NONNEG_MOVE_KEYS = new Set(['a0','a1','dmg','kb','stam','blockStam','lunge']); // arc/speedMult excluded — arc's a dot-product threshold (can be negative), speedMult has its own stricter >0 clamp
const DEFAULT_MOVES_BALANCE = Object.fromEntries(Object.entries(MOVES).map(([name,m])=>[name, Object.fromEntries(MOVE_BALANCE_KEYS.map(k=>[k,m[k]]))]));
const SPEED_MULT_RANGE = [0.1, 5];   // clamp: 0 or negative would make dur infinite/backwards; keeps the range sane either side

export function currentMovesBalance(){
  const out={}; for(const name of Object.keys(MOVES)) out[name]=Object.fromEntries(MOVE_BALANCE_KEYS.map(k=>[k,MOVES[name][k]]));
  return out;
}
export function applyMovesBalance(overrides={}){
  for(const name of Object.keys(MOVES)){
    const o = overrides[name] || {};
    for(const k of MOVE_BALANCE_KEYS){
      const def = DEFAULT_MOVES_BALANCE[name][k], v = o[k];
      if (k==='speedMult'){
        MOVES[name][k] = (typeof v==='number' && Number.isFinite(v) && v>0)
          ? Math.max(SPEED_MULT_RANGE[0], Math.min(SPEED_MULT_RANGE[1], v)) : def;
        continue;
      }
      const valid = typeof v==='number' && Number.isFinite(v) && (NONNEG_MOVE_KEYS.has(k) ? v>=0 : true);
      MOVES[name][k] = valid ? v : def;
    }
  }
  recomputeMoveDur();
  return currentMovesBalance();
}
