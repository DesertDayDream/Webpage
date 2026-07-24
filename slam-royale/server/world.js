// The authoritative game state. Runs headless on the server. Owns everything that
// clients are not allowed to decide: positions, health, hits, deaths, the zone,
// and the AI that backfills empty slots.

import { CFG, MOVES, isAtk, DEAD_DUR, DODGE_DUR, CLASH_STAGGER_DUR, STUN_DUR, GRABBED_DUR } from '../shared/constants.js';
import { newBody, stepBody, emptyCmd, fwd } from '../shared/movement.js';

let ent = 1;

export class World {
  constructor(){ this.bodies = new Map(); this.inputs = new Map(); this.events = []; this.reset(); }

  reset(){
    this.bodies.clear(); this.inputs.clear(); this.events.length = 0;
    this.radius = CFG.zoneR0; this.over = false; this.winner = null; this.spawnI = 0;
    // Battle countdown: step() below freezes everything until this hits 0, so a fresh
    // World always starts with the full countdown running, regardless of when players
    // actually finish joining/loading — see server/rooms.js's Room, which creates the
    // World only once it's ready to start ticking.
    this.countdownT = CFG.battleCountdown;
    // scattered pickups: throwable items (aim/throw, Q/E) at one radius, superstar-meter
    // orbs (instant pickup, no aim/throw) at another — both simple rings, deterministic
    this.items = ring(CFG.itemCount, 12, 0.4).map(p=>({ ...p, active:true, t:0 }));
    this.orbs = ring(CFG.orbCount, 18, 1.2).map(p=>({ ...p, active:true, t:0 }));
    this.projectiles = []; this.projId = 1;
  }

  spawnPos(){ const i=this.spawnI++; const a=(i/CFG.maxPlayers)*Math.PI*2 + Math.random()*0.3;
    return { x:Math.cos(a)*CFG.spawnRadius, z:Math.sin(a)*CFG.spawnRadius }; }

  addPlayer(id, name, char){
    const b=newBody(); const p=this.spawnPos(); b.x=p.x; b.z=p.z; b.heading=Math.atan2(-p.x,-p.z); b.rotY=b.heading;
    b.isAI=false; b.name=name||('P'+id); b.char=char||null; this.bodies.set(id,b); this.inputs.set(id, emptyCmd());
  }
  roster(){ const r={}; for(const [id,b] of this.bodies) if(!b.isAI) r[id]=b.char||null; return r; }
  addAI(){
    const id='ai'+(ent++); const b=newBody(); const p=this.spawnPos();
    b.x=p.x; b.z=p.z; b.heading=Math.atan2(-p.x,-p.z); b.rotY=b.heading; b.isAI=true; b.aicd=Math.random(); b.name='CPU';
    this.bodies.set(id,b); return id;
  }
  remove(id){ this.bodies.delete(id); this.inputs.delete(id); }
  fill(){ if (CFG.sandbox) return; while (this.bodies.size < CFG.maxPlayers) this.addAI(); }
  removeOneAI(){ for (const [id,b] of this.bodies) if (b.isAI){ this.remove(id); return true; } return false; }
  // One-shot/edge-triggered fields (light1/2/3, dodge, throw, activate) are OR'd onto
  // whatever's already pending instead of being overwritten outright — step() below
  // only reads this.inputs once per ITS OWN tick, but nothing stops multiple INPUT
  // messages from arriving between two server ticks (ordinary network jitter, or the
  // client's send rate transiently outpacing the server's tick rate). Overwriting
  // meant a message with e.g. activate:true immediately followed by one with
  // activate:false (the very next client tick, once the press had already been
  // consumed client-side) could erase the true before the server's own tick ever got
  // a chance to see it — the press would be silently lost server-side even though the
  // client's own local prediction had already acted on it, producing exactly the
  // "activates, then snaps back, then works on some later spammed attempt" symptom
  // this replaced. Continuous/held fields (movement, sprint, block, aim, heavyHeld,
  // jump) still just take the latest value — they represent what's held RIGHT NOW,
  // not a discrete event, so overwriting is correct for those.
  setInput(id, cmd){ if (!this.bodies.has(id)) return;
    const prev = this.inputs.get(id) || emptyCmd();
    this.inputs.set(id, { ...cmd,
      light1: cmd.light1||prev.light1, light2: cmd.light2||prev.light2, light3: cmd.light3||prev.light3,
      dodge: cmd.dodge||prev.dodge, throw: cmd.throw||prev.throw, activate: cmd.activate||prev.activate });
  }

  nearestEnemy(id, b){ let best=null, bd=1e9;
    for (const [oid,o] of this.bodies){ if (oid===id||!o.alive) continue;
      const d=Math.hypot(o.x-b.x, o.z-b.z); if (d<bd){ bd=d; best={id:oid, b:o, d}; } } return best; }

  aiCmd(id, b, dt){
    const c=emptyCmd(); if (!b.alive) return c; b.aicd -= dt;
    const dC=Math.hypot(b.x,b.z);
    if (dC > this.radius-2){ const l=dC||1; c.moveX=-b.x/l; c.moveZ=-b.z/l; c.sprint=true; return c; }
    if (b.superstar>=CFG.superstarMax) c.activate=true;
    const t=this.nearestEnemy(id,b); if (!t) return c;
    const dx=t.b.x-b.x, dz=t.b.z-b.z, dist=Math.hypot(dx,dz), nx=dx/(dist||1), nz=dz/(dist||1);
    if (b.carrying && dist>2 && dist<14 && Math.random()<0.02){ c.moveX=nx; c.moveZ=nz; c.throw=true; return c; }
    if (b.hp < b.maxHp*0.3 && dist<3){ c.moveX=-nx; c.moveZ=-nz; if (Math.random()<0.5) c.block=true; return c; }
    if (dist>2){ c.moveX=nx; c.moveZ=nz; c.sprint=dist>6; }
    else {
      c.moveX=nx*0.14; c.moveZ=nz*0.14;
      if (isAtk(t.b.action)){
        // mix of block and dodge reactions to an incoming attack, roughly matching
        // the bait/punish pattern (dodge past a whiffed grab, block a strike)
        const r=Math.random();
        if (r<0.25) c.dodge=true; else if (r<0.65) c.block=true;
      // still holding from a previous tick's grab decision (see below) — keep holding
      // until it either fires or gets interrupted (b.action leaves 'none' either way)
      } else if (b._aiGrabbing){
        c.heavyHeld=true;
        if (b.action!=='none') b._aiGrabbing=false;
      } else if (b.aicd<=0){ const r=Math.random();
        if (b.stam>=MOVES.grab.stam && r<0.15){ b._aiGrabbing=true; c.heavyHeld=true; }
        else if (b.stam>MOVES.heavy.stam && r<0.4){ c.heavyHeld=true; }   // one tick only = a tap, not a hold
        else c[['light1','light2','light3'][Math.floor(Math.random()*3)]]=true;   // 3 independent attacks now, not a combo — pick one
        b.aicd = 0.45 + Math.random()*0.6;
      }
    }
    return c;
  }

  step(dt){
    this.events.length = 0;
    if (this.over) return;
    // Frozen beat before the match actually begins — nobody moves or acts (stepBody
    // never runs, so even gravity/idle drift is on hold), the same for every player
    // since this is decided authoritatively here, not just drawn as an overlay on top
    // of an already-live match. battleStart fires exactly once, the instant it ends,
    // so clients know precisely when to cue the "BATTLE!" sting (see client/main.js).
    if (this.countdownT > 0){
      this.countdownT = Math.max(0, this.countdownT - dt);
      if (this.countdownT <= 0) this.events.push({ e:'battleStart' });
      return;
    }
    // per-body command → deterministic movement step
    for (const [id,b] of this.bodies){
      const cmd = b.isAI ? this.aiCmd(id,b,dt) : (this.inputs.get(id) || emptyCmd());
      stepBody(b, cmd, dt);
      // The one-shot fields setInput() OR-merges onto this stored cmd (see above) must
      // be cleared once this tick has actually consumed them — otherwise a merged-true
      // flag would keep re-firing on every subsequent tick until the next INPUT
      // message happens to overwrite it with false, instead of firing exactly once for
      // the single press it represented. `cmd` IS the stored object for a human player
      // (this.inputs.get(id) returns the same reference, not a copy) — mutating it here
      // is what actually clears it; harmless no-op for AI, whose cmd is a fresh object
      // from aiCmd() every tick anyway.
      cmd.light1=false; cmd.light2=false; cmd.light3=false; cmd.dodge=false; cmd.throw=false; cmd.activate=false;
      // a throw was just committed this tick (fresh 'throw' action, aEl still 0 — see
      // shared/movement.js's beginThrow) — spawn the actual projectile here, since only
      // the world (not the per-body step function) knows about other entities in flight
      if (b.action==='throw' && b.aEl===0){
        const f=fwd(b);
        // Camera pitch (b.aimPitch, tracked continuously — see shared/movement.js)
        // adjusts the launch on top of the baseline throwUpSpeed: looking up adds
        // hang time (farther, higher arc), looking down subtracts it (flatter,
        // shorter) — horizontal speed itself is untouched either way. Subtracted, not
        // added: render.js's Cam tracks pitch as the CAMERA's own orbit elevation (a
        // higher value swings the camera up and over, looking DOWN at the character
        // from above), which is the opposite sign from the player's own perceived
        // look-up/look-down direction — confirmed empirically (an addition here threw
        // farther when looking down and shorter when looking up, backwards).
        const vy=CFG.throwUpSpeed - b.aimPitch*CFG.throwPitchInfluence;
        this.projectiles.push({ id:this.projId++, owner:id, x:b.x+f.x*0.6, y:b.y+1.1, z:b.z+f.z*0.6,
          vx:f.x*CFG.throwSpeed, vy, vz:f.z*CFG.throwSpeed, life:CFG.throwLife });
      }
    }
    this.resolveCollisions();
    this.resolveHits();
    this.updateProjectiles(dt);
    this.updateItems(dt);
    this.checkEnd();
  }

  // advance thrown items, apply gravity, and resolve a hit against the first fighter
  // (other than the thrower) they come within range of; removed on hit, on hitting the
  // ground, or after its lifetime expires — whichever comes first
  updateProjectiles(dt){
    for(let i=this.projectiles.length-1;i>=0;i--){ const p=this.projectiles[i];
      p.vy+=CFG.gravity*dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt; p.life-=dt;
      let hit=false;
      for(const [tid,tg] of this.bodies){ if(tid===p.owner||!tg.alive) continue;
        if(tg.action==='dodge' && tg.aEl < DODGE_DUR*CFG.dodgeIframeFrac) continue;   // i-frames beat thrown items too
        const dx=tg.x-p.x, dz=tg.z-p.z, dy=(tg.y+1.0)-p.y, hd=Math.hypot(dx,dz);
        if(hd>CFG.throwHitRadius || Math.abs(dy)>1.2) continue;
        const nx=dx/(hd||1), nz=dz/(hd||1);
        const at=this.bodies.get(p.owner);
        let dmg=CFG.throwDmg; if(at && at.superstarActive) dmg*=CFG.superstarDmgMult;
        tg.hp-=dmg; tg.vx+=nx*CFG.throwKb; tg.vz+=nz*CFG.throwKb; this.stagger(tg,0.35);
        this.gainSuperstar(p.owner, dmg, tid);
        this.events.push({ e:'hit', x:p.x, z:p.z, a:p.owner, t:tid });
        if(tg.hp<=0) this.kill(tg, tid);
        hit=true; break;
      }
      if(hit || p.life<=0 || p.y<=0) this.projectiles.splice(i,1);
    }
  }

  // proximity pickup for both scattered-item types — instant, no input required, just
  // walk over it. Items grant one carry (aim/throw); orbs grant superstar meter directly.
  updateItems(dt){
    for(const it of this.items){
      if(!it.active){ it.t-=dt; if(it.t<=0) it.active=true; continue; }
      for(const [id,b] of this.bodies){ if(!b.alive||b.carrying) continue;
        if(Math.hypot(b.x-it.x,b.z-it.z)<=CFG.itemPickupRadius){ b.carrying=true; it.active=false; it.t=CFG.itemRespawn;
          this.events.push({ e:'itemPickup', t:id }); break; } }
    }
    for(const orb of this.orbs){
      if(!orb.active){ orb.t-=dt; if(orb.t<=0) orb.active=true; continue; }
      for(const [id,b] of this.bodies){ if(!b.alive) continue;
        if(Math.hypot(b.x-orb.x,b.z-orb.z)<=CFG.orbPickupRadius){ b.superstar=Math.min(CFG.superstarMax,b.superstar+CFG.orbGain); orb.active=false; orb.t=CFG.orbRespawn;
          this.events.push({ e:'orbPickup', t:id }); break; } }
    }
  }

  // shared by melee hits and projectile hits: fighting (dealing OR taking damage) fills
  // the superstar meter — frozen while a body is already in superstar mode (it just got
  // reset to 0 on activation, and is "spent" for the duration of the buff)
  gainSuperstar(aid, dmg, tid){
    const at=this.bodies.get(aid), tg=this.bodies.get(tid);
    if(at && !at.superstarActive) at.superstar=Math.min(CFG.superstarMax, at.superstar+dmg*CFG.superstarPerDmgDealt);
    if(tg && !tg.superstarActive) tg.superstar=Math.min(CFG.superstarMax, tg.superstar+dmg*CFG.superstarPerDmgTaken);
  }

  // Fighters physically push apart instead of walking through each other. Server-only
  // (not predicted client-side — the local client only has laggy/interpolated remote
  // positions to check against anyway) — a bump into someone else corrects via the
  // usual reconciliation snap, same as any other server correction.
  resolveCollisions(){
    const list=[...this.bodies.values()].filter(b=>b.alive);
    const minDist=CFG.fighterRadius*2;
    for(let i=0;i<list.length;i++){
      for(let j=i+1;j<list.length;j++){
        const a=list[i], b=list[j];
        const dx=b.x-a.x, dz=b.z-a.z, dist=Math.hypot(dx,dz);
        if(dist>=minDist || dist<=0.0001) continue;
        const push=(minDist-dist)/2, nx=dx/dist, nz=dz/dist;
        a.x-=nx*push; a.z-=nz*push; b.x+=nx*push; b.z+=nz*push;
      }
    }
  }

  // whether `at`'s swing (already known to be in its active window) actually reaches
  // `tg` right now — shared by both the clash-detection pass and the normal-hit pass
  // below so the geometry rule can't drift between the two.
  _reaches(at, tg, def){
    if (tg.action==='dodge' && tg.aEl < DODGE_DUR*CFG.dodgeIframeFrac) return false;   // i-frames beat everything
    const dx=tg.x-at.x, dz=tg.z-at.z, dist=Math.hypot(dx,dz); if (dist>def.range) return false;
    const f=fwd(at); const nx=dx/(dist||1), nz=dz/(dist||1);
    return (nx*f.x+nz*f.z) >= def.arc;
  }

  resolveHits(){
    // Collect every attacker whose swing is live THIS tick before resolving anything —
    // applyHit()/stagger() below mutates a target's `action` immediately, and doing
    // that mid-loop (the old, single-pass version of this method) meant whichever
    // attacker happened to come first in Map iteration order (i.e. whoever joined
    // first) silently staggered the other out of isAtk() before their own identical,
    // simultaneous swing ever got evaluated — a hidden first-mover-wins-ties bug, not
    // the "nobody wins" clash a mutual identical trade should actually produce.
    const attackers = [];
    for (const [aid,at] of this.bodies){
      if (!at.alive || !isAtk(at.action) || at.hasHit) continue;
      const def = MOVES[at.action]; if (at.ap < def.a0 || at.ap > def.a1) continue;
      attackers.push({ aid, at, def });
    }
    // Clash: two fighters throwing the IDENTICAL move, each one's swing reaching the
    // other, in the same tick — cancels out instead of either landing. Deliberately
    // exact-move-only (a light1 vs. a light3 still resolves as two ordinary hits);
    // "the same attack" is what actually clashes, not just "both are attacking."
    const clashed = new Set();
    for (let i=0;i<attackers.length;i++){
      const A = attackers[i]; if (clashed.has(A.aid)) continue;
      for (let j=i+1;j<attackers.length;j++){
        const B = attackers[j]; if (clashed.has(B.aid)) continue;
        if (A.at.action !== B.at.action) continue;
        if (!this._reaches(A.at,B.at,A.def) || !this._reaches(B.at,A.at,B.def)) continue;
        this.applyClash(A.at, B.at, A.aid, B.aid, A.def);
        clashed.add(A.aid); clashed.add(B.aid);
        break;   // A is spent — move on to the next unclashed attacker
      }
    }
    for (const {aid,at,def} of attackers){
      if (clashed.has(aid)) continue;   // already resolved as a clash, not a normal hit
      at.hasHit = true;
      for (const [tid,tg] of this.bodies){
        if (tid===aid || !tg.alive || clashed.has(tid)) continue;
        if (!this._reaches(at,tg,def)) continue;
        const dx=tg.x-at.x, dz=tg.z-at.z, dist=Math.hypot(dx,dz)||1;
        this.applyHit(at, tg, def, dx/dist, dz/dist, aid, tid);
      }
    }
  }
  applyClash(a, b, aid, bid, def){
    a.hasHit = true; b.hasHit = true;
    const dx=b.x-a.x, dz=b.z-a.z, dist=Math.hypot(dx,dz)||1, nx=dx/dist, nz=dz/dist;
    const kb = def.kb*CFG.clashKbMult;
    a.vx -= nx*kb; a.vz -= nz*kb; b.vx += nx*kb; b.vz += nz*kb;
    this.stagger(a, CLASH_STAGGER_DUR, 'clash'); this.stagger(b, CLASH_STAGGER_DUR, 'clash');
    a.hitstop = b.hitstop = CFG.hitstopClash;
    this.events.push({ e:'clash', x:(a.x+b.x)/2, z:(a.z+b.z)/2, a:aid, t:bid, dur:CLASH_STAGGER_DUR });
  }
  applyHit(at, tg, def, nx, nz, aid, tid){
    // oneShot (superAttack): forces exactly a lethal hit regardless of the target's
    // current hp, rather than a big-but-survivable number — a fixed MOVES.dmg could
    // still be survived if maxHp is retuned way up; this can't be. Note at.action is
    // ALREADY back to 'none' by the time this fires (committing to the attack ends
    // the buff immediately, see shared/movement.js) — the superstar multiplier below
    // is keyed off def (the move itself), not at.superstarActive, for exactly that reason.
    let dmg = def.oneShot ? tg.hp : def.dmg * (1 + at.level*0.12);
    // superstar mode: big damage buff, plus an extra-hard version of heavy specifically
    // (the "unique heavy-hitting move" — same button/animation, scaled-up numbers)
    if (!def.oneShot && at.superstarActive) dmg *= (at.action==='heavy' ? CFG.superstarHeavyMult : CFG.superstarDmgMult);
    const tf = fwd(tg); const front = (-nx)*tf.x + (-nz)*tf.z;
    const mx=(at.x+tg.x)/2, mz=(at.z+tg.z)/2;
    // unblockable (grab/superAttack): skips the block branch entirely, even if tg is
    // actively blocking with block-stamina to spare — "grabs break the shield."
    // Absorbing a hit spends the dedicated block-stamina pool (def.blockStam, scaled
    // by the ATTACKER's move — heavier moves cost more to block), not the regular
    // stamina pool — see shared/movement.js/CFG.maxBlockStam for the rest of that
    // pool's behavior (passive drain, regen). Draining it to 0 this way is the harsher
    // guard-break case and still staggers, same as before this pool existed.
    if (!def.unblockable && tg.action==='block' && front>0.1 && tg.blockStam>0){
      dmg*=0.15; tg.blockStam=Math.max(0,tg.blockStam-def.blockStam); tg.blockStamRegenT=CFG.blockStamRegenDelay;
      tg.hp-=dmg; tg.vx+=nx*def.kb*0.25; tg.vz+=nz*def.kb*0.25;
      this.events.push({ e:'block', x:mx, z:mz, t:tid });
      at.hitstop=tg.hitstop=CFG.hitstopBlock;
      if (tg.blockStam<=0) this.stagger(tg,STUN_DUR,'stunned');       // guard break — same stun as any other stamina exhaustion
    } else {
      // grabbed is its own reaction state AND its own tracked duration (GRABBED_DUR,
      // shared/constants.js) — distinct from def.hit (the generic punch-flinch
      // reaction, proportionally scaled off the "hit" clip). Using def.hit here too
      // would size the "being thrown" hold off an unrelated clip's length, drifting
      // out of sync with whatever "grabbed" clip is actually mapped.
      const reactDur = def.unblockable ? GRABBED_DUR : def.hit;
      tg.hp-=dmg; tg.vx+=nx*def.kb; tg.vz+=nz*def.kb; this.stagger(tg, reactDur, def.unblockable?'grabbed':'hit');
      this.events.push({ e:def.unblockable?'grab':'hit', x:mx, z:mz, a:aid, t:tid, dur:reactDur });
      at.hitstop=tg.hitstop = def.unblockable ? CFG.hitstopGrab : (at.action==='heavy'?CFG.hitstopHeavy:CFG.hitstopHit);
      if (tg.hp<=0) this.kill(tg, tid);
    }
    this.gainSuperstar(aid, dmg, tid);
  }
  stagger(b, dur, state='hit'){ b.action=state; b.dur=dur; b.aEl=0; b.ap=0; }
  // hitstop=0 matters here, not just cosmetically: the killing blow itself just set
  // hitstop to a brief impact-freeze value (applyHit(), right before this call), and
  // stepBody()'s !b.alive branch returns before ever reaching the code that decays
  // hitstop back down — so left untouched, it would stay stuck above 0 forever.
  // client/render.js computes its per-frame dt as 0 whenever hitstop>0, so a dead
  // body with stuck hitstop never advances its animation mixer again: no crossfade,
  // no dead pose, frozen exactly on whatever frame was showing at the moment of death.
  kill(b, id){ if (!b.alive) return; b.alive=false; b.action='dead'; b.dur=DEAD_DUR; b.aEl=0; b.hitstop=0; this.events.push({ e:'ko', t:id, dur:DEAD_DUR }); }

  checkEnd(){
    if (CFG.sandbox) return;   // no bots to be "last one standing" against — never ends
    const alive = [...this.bodies].filter(([,b])=>b.alive);
    if (alive.length<=1){ this.over=true; this.winner = alive.length ? alive[0][0] : null; this.events.push({ e:'end' }); }
  }

  snapshot(){
    const b=[]; for (const [id,o] of this.bodies){
      b.push({ id, x:o.x, y:o.y, z:o.z, vx:o.vx, vy:o.vy, vz:o.vz, rotY:o.rotY, heading:o.heading, grounded:o.grounded,
               action:o.action, dur:o.dur, aEl:o.aEl, ap:o.ap, hasHit:o.hasHit, combo:o.combo, comboT:o.comboT,
               hp:o.hp, maxHp:o.maxHp, stam:o.stam, maxStam:o.maxStam, blockStam:o.blockStam, maxBlockStam:o.maxBlockStam,
               level:o.level, alive:o.alive, ai:o.isAI?1:0, hitstop:o.hitstop,
               carrying:o.carrying?1:0, aiming:o.aiming?1:0, superstar:o.superstar, superstarActive:o.superstarActive?1:0 });
    }
    const items=this.items.map(it=>({x:it.x,z:it.z,a:it.active?1:0}));
    const orbs=this.orbs.map(o=>({x:o.x,z:o.z,a:o.active?1:0}));
    const proj=this.projectiles.map(p=>({id:p.id,x:p.x,y:p.y,z:p.z}));
    return { r:this.radius, over:this.over?1:0, win:this.winner, b, ev:this.events.slice(), items, orbs, proj, cd:this.countdownT };
  }
}

const ring=(n,radius,offset=0)=>{ const out=[]; for(let i=0;i<n;i++){ const a=(i/n)*Math.PI*2+offset; out.push({x:Math.cos(a)*radius, z:Math.sin(a)*radius}); } return out; };
