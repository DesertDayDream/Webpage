// Deterministic per-fighter step. The SAME function runs on the server (authority)
// and on the client (local prediction). Identical inputs + dt → identical results,
// which is what makes prediction/reconciliation converge. Combat *outcomes* (who got
// hit, damage) are resolved separately and only by the server — see server/world.js.

import { CFG, MOVES, isAtk, DODGE_DUR, STUN_DUR } from './constants.js';

export function newBody() {
  return {
    x:0, y:0, z:0, vx:0, vy:0, vz:0, rotY:0, heading:0, grounded:true,
    action:'none', dur:0, aEl:0, ap:0, hasHit:false, combo:0, comboT:0,
    hp:CFG.maxHp, maxHp:CFG.maxHp, stam:CFG.maxStam, maxStam:CFG.maxStam, level:1, alive:true,
    isAI:false, name:'',
    bufLight:false, bufLightWhich:null, bufHeavy:false, bufDodge:false,  // sticky "pending" flags — see stepBody
    bufThrowT:0,   // throw's buffer is a short TIMED window instead — see stepBody
    lightCooldownT:{light1:0,light2:0,light3:0},        // per-move cooldown after THAT move fires; independent — firing light1 doesn't touch light2/3's — see stepBody
    stamRegenT:0,                                      // counts down to 0 after a stam spend; regen only resumes once it hits 0 — see stepBody
    // block stamina: separate pool dedicated to holding block (see CFG.maxBlockStam) —
    // drains passively while blocking and extra per absorbed hit (server/world.js's
    // applyHit()), regens like normal stamina once you stop blocking — see stepBody
    blockStam:CFG.maxBlockStam, maxBlockStam:CFG.maxBlockStam, blockStamRegenT:0,
    // Draining regular stamina to 0 stuns you (see stepBody) — pendingStun defers that
    // until you're actually free to be interrupted (not mid-swing on a move you
    // already paid the last of your stamina for), same "remembered until the gate
    // opens" idea as the other buffered flags above.
    pendingStun:false,
    heavyHoldT:0,                                      // how long the heavy key has been continuously held — tap=heavy, hold past CFG.grabHoldThreshold=grab
    hitstop:0,                                        // brief full freeze on impact ("hit pause")
    // items (aim/throw — Q/E) — pickup/projectile physics are server-only (see
    // server/world.js), this is just the state the client also needs to predict/render
    carrying:false, aiming:false,
    // Camera pitch at the most recent input, tracked continuously (not just while
    // actually throwing) — server/world.js reads this at the exact tick a throw
    // commits to angle the projectile's launch (steeper look-up = higher arc = more
    // hang time = farther; look-down = flatter/shorter), so it always has an
    // up-to-date value the instant it's needed rather than one from a stale tick.
    aimPitch:0,
    // superstar mode (R) — meter fills from dealing/taking damage or orb pickups
    // (server-only, see server/world.js), activation itself is predicted like an attack
    superstar:0, superstarActive:false, superstarT:0,
  };
}

export function emptyCmd() {
  return { moveX:0, moveZ:0, sprint:false, jump:false, light1:false, light2:false, light3:false, heavyHeld:false, block:false, aim:false, throw:false, dodge:false, activate:false, pitch:0 };
}

export const fwd = b => ({ x:Math.sin(b.rotY), z:Math.cos(b.rotY) });

function begin(b, name, dur){ b.action=name; b.dur=dur; b.aEl=0; b.ap=0; b.hasHit=false; }
function beginAtk(b, name){
  const d = MOVES[name]; if (b.stam < d.stam) return false;
  b.stam -= d.stam; b.stamRegenT = CFG.stamRegenDelay; begin(b, name, d.dur);
  return true;
}
// 0..1 shape over an attack's progress: ramp up through wind-up (0..a0), hold at peak
// through the active window (a0..a1 — the same window hit detection uses), ease back
// down through recovery (a1..1). Multiplied by MOVES[name].lunge for the actual target
// speed — see stepBody's movement section.
function lungeShape(ap, d){
  if (ap < d.a0) return d.a0>0 ? ap/d.a0 : 1;
  if (ap <= d.a1) return 1;
  const tail = 1-d.a1;
  return tail>0 ? Math.max(0, 1-(ap-d.a1)/tail) : 0;
}
// light1/2/3 are 3 independently-bound attacks now (see client/main.js), not an
// auto-advancing combo — `name` is whichever one was actually pressed (bufLightWhich,
// set below). combo/comboT still track a pure hit-streak count for the HUD's
// "COMBO ×N" popup (see main.js) — it no longer decides which move fires, just how
// many landed in a row; it resets by moving while genuinely idle (see stepBody).
function beginLight(b, name){
  const ok = beginAtk(b, name);
  if (ok){ b.combo = (b.combo+1)%3; b.comboT = 0.65; b.lightCooldownT[name] = CFG.lightInputCooldown; }
  return ok;
}
// Consumes the carried item immediately (matches light/heavy's "the game state changes
// the instant you commit" feel) — the actual projectile is a world-level entity, not
// per-body state, so it's spawned server-side in server/world.js's step(), not here.
function beginThrow(b){ b.carrying=false; b.aiming=false; begin(b,'throw',CFG.throwDur); }
// Directional burst (toward input, or backward if not moving) + i-frames — the actual
// invincibility check lives in server/world.js's resolveHits() (it's about whether an
// INCOMING hit connects, not something stepBody resolves), gated on CFG.dodgeIframeFrac
// of DODGE_DUR, same as before this was ever removed.
function beginDodge(b, cmd){
  b.stam -= CFG.dodgeStam; b.stamRegenT = CFG.stamRegenDelay; begin(b, 'dodge', DODGE_DUR);
  let mx=cmd.moveX, mz=cmd.moveZ; if (!(mx||mz)){ const f=fwd(b); mx=-f.x; mz=-f.z; }
  const l=Math.hypot(mx,mz)||1; b.vx=mx/l*CFG.dodgeSpeed; b.vz=mz/l*CFG.dodgeSpeed;
}

// Advance one fixed step for a single body given its command.
export function stepBody(b, cmd, dt){
  if (!b.alive){ b.vx*=Math.exp(-8*dt); b.vz*=Math.exp(-8*dt); b.x+=b.vx*dt; b.z+=b.vz*dt; b.action='dead'; return; }

  // Tracked unconditionally, every tick — see aimPitch's own comment in newBody().
  b.aimPitch = cmd.pitch||0;

  // Snapshot BEFORE anything this tick can spend stamina (attacks, dodge, sprint drain
  // further below) — comparing against this at the end of the tick is how a 0-crossing
  // gets detected regardless of which of those actually caused it, without needing to
  // duplicate the same check at every individual spend site.
  const stamBefore = b.stam;

  // record a press even through hit pause, so it isn't lost while frozen — refreshed
  // here unconditionally; consumption only happens once unfrozen, below. These flags
  // never expire on their own — as long as one is pending, the gate below keeps
  // retrying it every single tick, exactly like block (which needs no buffer at all
  // because it's just a continuous held check) — so a press is guaranteed to fire the
  // instant you're free, no matter how long that takes, instead of silently getting
  // dropped if the gate doesn't open within some fixed window. Stamina is the one
  // exception: a press made without enough stamina for it right then is a genuine
  // rejection, not a timing wait — it doesn't get remembered, so it can't suddenly
  // fire on its own later just because stamina happened to regen in the meantime.
  // light1/2/3 are 3 separate inputs (see client/main.js) sharing one pending slot —
  // whichever was pressed most recently is what fires. Each has its OWN cooldown (see
  // CFG.lightInputCooldown) — firing light1 debounces only light1, so chaining a
  // different move right after isn't blocked; a press against a move still on
  // cooldown is ignored outright, same as insufficient stamina, not remembered later.
  // Carrying a throwable locks out the whole combat kit (see the gate below) — none of
  // these presses get buffered in the first place while carrying, so nothing stale is
  // sitting there waiting to fire the instant the item's thrown and the lock lifts.
  // Same reasoning for being stunned: a press made while stunned is a genuine
  // rejection, same as insufficient stamina — remembering it would hand out a free
  // instant attack the moment the stun ends, undercutting the whole point of being
  // punished for running yourself out of stamina in the first place.
  if (!b.carrying && b.action!=='stunned'){
    if (cmd.light1 && b.lightCooldownT.light1<=0 && b.stam>=MOVES.light1.stam){ b.bufLight=true; b.bufLightWhich='light1'; }
    else if (cmd.light2 && b.lightCooldownT.light2<=0 && b.stam>=MOVES.light2.stam){ b.bufLight=true; b.bufLightWhich='light2'; }
    else if (cmd.light3 && b.lightCooldownT.light3<=0 && b.stam>=MOVES.light3.stam){ b.bufLight=true; b.bufLightWhich='light3'; }
    // Deliberately NOT gated on b.action the way light/heavy above aren't either — a
    // press slightly before you're free to act (still mid-recovery of some OTHER
    // move) should still fire the instant it opens up, same forgiving-timing idea as
    // everywhere else. But EXCLUDED specifically while b.action is ALREADY 'dodge':
    // unlike attacks (where mashing to combo-chain into another swing the instant one
    // ends is the intended feel), a second dodge press landing mid-dodge and then
    // auto-firing another dodge right as the first one ends is a surprising, unasked-
    // for double-dodge — a quick double-tap meant to be "dodge once" shouldn't queue a
    // second one up behind it.
    if (cmd.dodge && b.stam>=CFG.dodgeStam && b.action!=='dodge') b.bufDodge=true;
    // Heavy key hold-detection: tap (released before the threshold) queues an ordinary
    // heavy strike, same as before; holding PAST the threshold commits to a grab instead
    // (see the gate below) — heavyHoldT keeps accumulating across hitstop/mid-swing too,
    // so a grab you've already been charging fires the instant you're free to act.
    if (cmd.heavyHeld) b.heavyHoldT += dt;
    else { if (b.heavyHoldT>0 && b.heavyHoldT<CFG.grabHoldThreshold && b.stam>=MOVES.heavy.stam) b.bufHeavy=true; b.heavyHoldT=0; }
  }
  // Throw's buffer is a short TIMED window, not an infinite-until-consumed sticky flag
  // like the others above — and deliberately NOT gated on carrying at press time
  // either (a previous version required it, to stop a stray press with nothing
  // carried from sitting there forever and firing itself on some much-later,
  // unrelated pickup — but that overcorrected: pickups are server-authoritative only,
  // never locally predicted, so a normal "walk onto it and immediately mash E" press
  // routinely lands a tick or two before carrying=true has even arrived locally, and
  // requiring carrying right then just silently dropped it, needing a second or third
  // press to happen to land after confirmation instead). A brief window is the middle
  // ground: long enough to bridge that one-or-two-tick pickup-confirmation gap, short
  // enough that a press against nothing can't survive to haunt a later pickup.
  if (cmd.throw && b.action!=='stunned') b.bufThrowT=0.2;
  else if (b.bufThrowT>0) b.bufThrowT=Math.max(0,b.bufThrowT-dt);

  // hit pause: a brief total freeze on impact (see server/world.js applyHit). Nothing
  // else advances while this is ticking down (a pending press above still counts).
  if (b.hitstop>0){ b.hitstop=Math.max(0,b.hitstop-dt); return; }

  if (b.comboT>0) b.comboT=Math.max(0,b.comboT-dt);
  if (b.lightCooldownT.light1>0) b.lightCooldownT.light1=Math.max(0,b.lightCooldownT.light1-dt);
  if (b.lightCooldownT.light2>0) b.lightCooldownT.light2=Math.max(0,b.lightCooldownT.light2-dt);
  if (b.lightCooldownT.light3>0) b.lightCooldownT.light3=Math.max(0,b.lightCooldownT.light3-dt);
  if (b.superstarActive){ b.superstarT-=dt; if (b.superstarT<=0){ b.superstarActive=false; b.superstarT=0; } }

  // advance current action timeline
  if (b.action!=='none' && b.action!=='block'){
    b.aEl+=dt; b.ap=b.aEl/b.dur;
    if (b.aEl>=b.dur) b.action='none';
  }
  // start a new action if free, or cancelling the tail of an attack — checked against
  // the pending flags above (not the raw cmd) so an early press still registers on the
  // frame this gate opens, however long ago it was actually pressed.
  const moving = (cmd.moveX||cmd.moveZ);
  const cancel = isAtk(b.action) && b.aEl > b.dur*0.62;
  // Light is meant to combo-chain into itself/other moves early via the cancel window
  // above — that's the intended "mash to combo" feel. Grab/heavy are NOT: re-triggering
  // either off its own cancel window let holding/pressing the key restart the same
  // committed swing or grab mid-animation, which read as the move interrupting itself
  // rather than a deliberate follow-up. So grab/heavy may only start once the CURRENT
  // action has genuinely ended (or cancels out of some OTHER move, e.g. a light) —
  // never out of their own cancel window. heavyHoldT/bufHeavy stay untouched (not
  // cleared) when blocked here, so a held/queued press still fires the instant the
  // current heavy/grab actually finishes, same forgiving-timing idea as everywhere else.
  const heavyGrabOk = b.action==='none' || b.action==='block' || (cancel && b.action!=='heavy' && b.action!=='grab');
  if (b.action==='none' || b.action==='block' || cancel){
    // Carrying a throwable locks you into it — no light/heavy/grab/dodge until it's
    // thrown (or you'd otherwise fight one-handed while holding the thing two-handed).
    if (b.carrying){ if (b.bufThrowT>0){ beginThrow(b); b.bufThrowT=0; } }
    else if (heavyGrabOk && b.heavyHoldT>=CFG.grabHoldThreshold){ if (beginAtk(b,'grab')) b.heavyHoldT=0; }
    // Pending flags below are cleared unconditionally on attempt (not just on success)
    // — they were already stamina-checked at press time above, so reaching here with
    // insufficient stamina would mean it dropped in the meantime (e.g. a block-chip
    // hit); either way, an attempt was made and it doesn't get another free retry.
    else if (heavyGrabOk && b.bufHeavy){ beginAtk(b,'heavy'); b.bufHeavy=false; }
    else if (b.bufLight){ beginLight(b,b.bufLightWhich); b.bufLight=false; }
    else if (b.bufDodge){ if (b.stam>=CFG.dodgeStam) beginDodge(b,cmd); b.bufDodge=false; }
    // nothing pending and genuinely free to act (not just cancel-eligible tail of an
    // attack) — moving instead of continuing the chain abandons it. Reaching this
    // branch already means bufLight is false (the branch above would've caught it),
    // so this can't fight a press still pending.
    else if (moving && b.action==='none') b.combo=0;
  }
  // block releases the instant the button does — no minimum commitment. If the mapped
  // clip is longer than how long you held it, it just gets faded out mid-animation
  // (ModelAnimator's crossfade) rather than forcing you to sit through the rest of it.
  // Locked out entirely while carrying, same as the other combat moves above — and now
  // also while genuinely out of block stamina (see the drain below): can't raise a
  // guard you have nothing left to hold up.
  if (b.action==='none' && cmd.block && !b.carrying && b.blockStam>0) b.action='block';
  if (b.action==='block' && !cmd.block) b.action='none';

  // Block stamina: passive drain while actively held — this (not the hit-absorption
  // cost in server/world.js's applyHit()) is what actually caps how long you can turtle
  // with nobody even swinging at you. Draining it to 0 either way now stuns you (see
  // STUN_DUR) — block is freely droppable at will (unlike a committed attack), so
  // there's no "let it finish first" concern here; the stun can apply immediately.
  // Regens like normal stamina — delay-then-rate — once you're not actively blocking.
  if (b.action==='block'){
    b.blockStam=Math.max(0,b.blockStam-CFG.blockStamDrain*dt); b.blockStamRegenT=CFG.blockStamRegenDelay;
    if (b.blockStam<=0) begin(b,'stunned',STUN_DUR);
  } else if (b.blockStamRegenT>0) b.blockStamRegenT=Math.max(0,b.blockStamRegenT-dt);
  else if (b.blockStam<b.maxBlockStam) b.blockStam=Math.min(b.maxBlockStam,b.blockStam+CFG.blockStamRegen*dt);

  // aiming (Q): purely a telegraph — slows you while lining up a throw. Only while
  // actually carrying something and free to act; never during an attack/throw/block.
  b.aiming = b.carrying && cmd.aim && b.action==='none';

  // superstar mode (R): first press (meter full) activates the temporary buff — no
  // animation lock, it's a buff state, not a committed action. A SECOND press while
  // already active instead commits to the superAttack finisher — an ordinary MOVES
  // entry via beginAtk (see shared/constants.js / server/world.js's applyHit() for the
  // actual one-shot-kill resolution), gated the same way every other attack is (must
  // be free to act, locked out while carrying) and immediately ending the buff on
  // success — one guaranteed kill per full meter, not a repeat-until-the-buff-runs-out
  // one-shot machine gun.
  if (cmd.activate && b.action==='none'){
    if (!b.superstarActive && b.superstar>=CFG.superstarMax){
      b.superstarActive=true; b.superstarT=CFG.superstarDuration; b.superstar=0;
    } else if (b.superstarActive && !b.carrying && beginAtk(b,'superAttack')){
      b.superstarActive=false; b.superstarT=0;
    }
  }

  // horizontal movement: faster accel while holding input, snappier decel on release,
  // reduced (but not eliminated) control while airborne
  const canMove = b.action==='none' || b.action==='block';
  // Sprint only actually costs anything while genuinely running (held AND moving AND
  // still got stamina left) — holding Shift standing still, or with 0 stamina, is
  // free (and silently caps you at walk speed until it regens, same as block simply
  // dropping on its own once its own pool runs dry).
  const sprinting = cmd.sprint && moving && b.stam>0;
  let spd = sprinting ? CFG.run : CFG.walk; if (b.action==='block') spd*=0.4;
  if (b.aiming) spd*=CFG.aimSpeedMult;
  if (b.superstarActive) spd*=CFG.superstarSpeedMult;
  const atkMove = isAtk(b.action) ? MOVES[b.action] : null;
  if (canMove){
    const rate = (moving?CFG.accel:CFG.decel) * (b.grounded?1:CFG.airControl);
    const k=1-Math.exp(-rate*dt);
    b.vx += (cmd.moveX*spd - b.vx)*k;
    b.vz += (cmd.moveZ*spd - b.vz)*k;
  } else if (atkMove && atkMove.lunge>0){
    // displacement driven entirely by the move's own curve — WASD has no say here
    // (matches heavy's committed, animation-locked lunge; see lungeShape above)
    const f=fwd(b), tgt=atkMove.lunge*lungeShape(b.ap,atkMove);
    const k=1-Math.exp(-16*dt);
    b.vx += (f.x*tgt - b.vx)*k; b.vz += (f.z*tgt - b.vz)*k;
  } else {
    const f=Math.exp(-6*dt); b.vx*=f; b.vz*=f;   // slide: throw lock / knockback decay while rooted
  }
  // Gated on canMove too — sprint speed above only actually applies to velocity in
  // that same branch, so there's nothing to charge for it while mid-attack/throw/etc.
  // (cmd.sprint held during a committed move is a no-op either way, same as it always
  // was, just now also free rather than silently draining for a speed you're not
  // getting).
  if (sprinting && canMove){ b.stam=Math.max(0,b.stam-CFG.sprintStamDrain*dt); b.stamRegenT=CFG.stamRegenDelay; }

  // Stamina exhaustion stun: checked once, after every possible spend this tick
  // (attacks/dodge earlier, sprint just above) — pendingStun defers the actual stun
  // until you're free to be interrupted. beginAtk/beginDodge already refuse to START
  // something you can't afford, but a move that spends EXACTLY your last point still
  // gets to play out — you already paid for it — rather than being yanked away mid-
  // swing the instant stamina crosses 0. Block hitting 0 is handled separately above
  // (immediate — block has no "let it finish" concern, it's droppable at will).
  if (stamBefore>0 && b.stam<=0) b.pendingStun=true;
  if (b.pendingStun && canMove){ b.pendingStun=false; begin(b,'stunned',STUN_DUR); }

  // gravity + jump + integrate
  b.vy += CFG.gravity*dt; if (b.vy < -CFG.maxFallSpeed) b.vy = -CFG.maxFallSpeed;
  if (b.grounded && cmd.jump && canMove) b.vy = CFG.jumpSpeed;
  b.x += b.vx*dt; b.z += b.vz*dt; b.y += b.vy*dt;
  if (b.y<=0){ b.y=0; b.vy=0; b.grounded=true; } else b.grounded=false;

  // facing (locked during attacks / hitstun)
  if (moving && canMove) b.heading = Math.atan2(b.vx, b.vz);
  let d = b.heading - b.rotY; d = Math.atan2(Math.sin(d), Math.cos(d));
  b.rotY += d*(1-Math.exp(-CFG.turn*dt));

  // regen pauses for stamRegenDelay after any spend (attacking, dodging, or a chip-
  // damage block hit — see server/world.js), then resumes at stamRegen/s, boosted by
  // stamRegenBlockMult while actively holding block.
  if (b.stamRegenT>0) b.stamRegenT=Math.max(0,b.stamRegenT-dt);
  if (CFG.stamRegen>0 && b.stamRegenT<=0 && b.stam < b.maxStam){
    const rate = CFG.stamRegen * (b.action==='block' ? CFG.stamRegenBlockMult : 1);
    b.stam = Math.min(b.maxStam, b.stam + rate*dt);
  }
}
