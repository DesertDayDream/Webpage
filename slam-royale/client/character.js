// Unified character layer used by BOTH the studio (preview) and the game (match).
// Produces animators with a common interface: { obj, update(dt, info) } where
// info = { alive, action, ap, vy, grounded, speed, carrying }. Two implementations:
//   ProceduralAnimator – the built-in rig with full procedural combat poses (fallback)
//   ModelAnimator      – a loaded GLTF/FBX rig, clips crossfaded off the game states
// A CharacterFactory loads a rig + clips once and instances it (SkeletonUtils clone)
// for the local player and every remote using the same character.

import * as THREE from 'three';
import { CFG, MOVES, isAtk } from '../shared/constants.js';

export const ALLSTATES = ['idle','walk','run','jump','fall','light1','light2','light3','heavy','grab','superAttack','block','throw','dodge','hit','grabbed','clash','dead','carry','stunned'];
const PALETTE = [0x3b82f6,0xef4444,0x22c55e,0xeab308,0xa855f7,0xf97316,0x14b8a6,0xec4899];
export const paletteColor = i => PALETTE[i % PALETTE.length];

export function decideState(grounded, speed, vy){
  if (!grounded) return vy > 0.5 ? 'jump' : 'fall';
  if (speed < 0.35) return 'idle';
  return speed > (CFG.walk + CFG.run)/2 ? 'run' : 'walk';
}

/* ---------------- procedural rig + animator (full combat) ---------------- */
// Lambert (diffuse-only, no specular/roughness computation) instead of Standard —
// much cheaper fragment shader across 8 independently-animated fighters, still lit
// by the scene's hemisphere/directional lights so it doesn't look flat-unlit.
const mat = c=>new THREE.MeshLambertMaterial({color:c});
function limb(len,rad,material){ const g=new THREE.Group();
  const me=new THREE.Mesh(new THREE.CapsuleGeometry(rad,len,6,12),material); me.castShadow=true; me.position.y=-(len/2+rad); g.add(me); g.userData.tip=-(len+rad*2); return g; }
export function buildRig(team){
  const skin=mat(0xd9a679), jersey=mat(team), shorts=mat(0x23262e);
  const root=new THREE.Group();
  const hips=new THREE.Group(); hips.position.y=1.0; root.add(hips);
  const torso=new THREE.Group(); hips.add(torso);
  const tm=new THREE.Mesh(new THREE.CapsuleGeometry(0.20,0.42,6,12),jersey); tm.position.y=0.40; tm.castShadow=true; torso.add(tm);
  const head=new THREE.Group(); head.position.y=0.82; torso.add(head);
  const hm=new THREE.Mesh(new THREE.SphereGeometry(0.17,16,14),skin); hm.castShadow=true; head.add(hm);
  const arm=s=>{ const sh=new THREE.Group(); sh.position.set(0.27*s,0.60,0); sh.rotation.z=0.12*s;
    const u=limb(0.26,0.075,jersey), l=limb(0.24,0.062,skin); l.position.y=u.userData.tip; u.add(l); sh.add(u); torso.add(sh); return {sh,el:l}; };
  const armL=arm(1),armR=arm(-1);
  const leg=s=>{ const hp=new THREE.Group(); hp.position.set(0.12*s,0,0);
    const u=limb(0.34,0.105,shorts), l=limb(0.34,0.085,skin); l.position.y=u.userData.tip;
    const f=new THREE.Mesh(new THREE.BoxGeometry(0.14,0.07,0.26),mat(0x14161b)); f.position.set(0,l.userData.tip+0.02,0.07); f.castShadow=true; l.add(f);
    u.add(l); hp.add(u); hips.add(hp); return {hp,kn:l}; };
  const legL=leg(1),legR=leg(-1);
  // fighters don't cast shadows in-match (perf: 8 dynamic casters is the costliest
  // part of the shadow pass) — they still receive them from the world.
  root.traverse(o=>{ if(o.isMesh){ o.receiveShadow=true; o.castShadow=false; } });
  root.userData.j={hips,torso,head,armL,armR,legL,legR};
  return root;
}
// A simple placeholder rig + a few basic clips, used by the Studio ("Load sample")
// as a stand-in when previewing the mapping mechanics without a real rigged model.
export function buildSampleRig(){
  const std=(c,r=0.7)=>new THREE.MeshStandardMaterial({color:c,roughness:r}); const nm=(n,o)=>{o.name=n;return o;};
  const lb=(len,rad,m)=>{ const g=new THREE.Group(); const me=new THREE.Mesh(new THREE.CapsuleGeometry(rad,len,6,12),m); me.castShadow=true; me.position.y=-(len/2+rad); g.add(me); g.userData.tip=-(len+rad*2); return g; };
  const skin=std(0xd9a679),jersey=std(0x3b82f6,0.5),shorts=std(0x23262e,0.85);
  const root=new THREE.Group(); root.name='sample';
  const hips=nm('hips',new THREE.Group()); hips.position.y=1.0; root.add(hips);
  const torso=nm('torso',new THREE.Group()); hips.add(torso);
  const tm=new THREE.Mesh(new THREE.CapsuleGeometry(0.20,0.42,6,12),jersey); tm.position.y=0.40; tm.castShadow=true; torso.add(tm);
  const head=nm('head',new THREE.Group()); head.position.y=0.82; torso.add(head);
  const hm=new THREE.Mesh(new THREE.SphereGeometry(0.17,16,14),skin); hm.castShadow=true; head.add(hm);
  const arm=(s,nu,ne)=>{ const sh=nm(nu,new THREE.Group()); sh.position.set(0.27*s,0.60,0); sh.rotation.z=0.12*s;
    const u=lb(0.26,0.075,jersey); const e=nm(ne,new THREE.Group()); e.position.y=u.userData.tip; const l=lb(0.24,0.062,skin); e.add(l); u.add(e); sh.add(u); torso.add(sh); };
  arm(1,'armL','elbowL'); arm(-1,'armR','elbowR');
  const leg=(s,nu,nk)=>{ const hp=nm(nu,new THREE.Group()); hp.position.set(0.12*s,0,0);
    const u=lb(0.34,0.105,shorts); const k=nm(nk,new THREE.Group()); k.position.y=u.userData.tip; const l=lb(0.34,0.085,skin);
    const f=new THREE.Mesh(new THREE.BoxGeometry(0.14,0.07,0.26),std(0x14161b)); f.position.set(0,l.userData.tip+0.02,0.07); f.castShadow=true; l.add(f);
    k.add(l); u.add(k); hp.add(u); hips.add(hp); };
  leg(1,'legL','kneeL'); leg(-1,'legR','kneeR');
  root.traverse(o=>{ if(o.isMesh)o.receiveShadow=true; }); return root;
}
export function buildSampleClips(){
  const clip=(name,dur,fn)=>{ const K=17,times=[],q={},hp=[],nodes=['armL','armR','legL','legR','kneeL','kneeR','torso']; nodes.forEach(n=>q[n]=[]);
    for(let i=0;i<K;i++){ const p=i/(K-1); times.push(p*dur); const e=fn(p);
      nodes.forEach(n=>{ const eu=e[n]||{}; const Q=new THREE.Quaternion().setFromEuler(new THREE.Euler(eu.x||0,eu.y||0,eu.z||0)); q[n].push(Q.x,Q.y,Q.z,Q.w); });
      hp.push(0,1.0+(e.bob||0),0); }
    const tr=nodes.map(n=>new THREE.QuaternionKeyframeTrack(n+'.quaternion',times,q[n])); tr.push(new THREE.VectorKeyframeTrack('hips.position',times,hp));
    return new THREE.AnimationClip(name,dur,tr); };
  const idle=clip('Idle',3,p=>{ const b=Math.sin(p*Math.PI*2); return {torso:{x:0.02},armL:{x:b*0.03,z:0.05},armR:{x:-b*0.03,z:-0.05},kneeL:{x:0.05},kneeR:{x:0.05},bob:b*0.01}; });
  const gait=(dur,amp,lean)=>clip(dur<0.9?'Run':'Walk',dur,p=>{ const ph=p*Math.PI*2,s=Math.sin(ph);
    return {legL:{x:s*amp},legR:{x:-s*amp},armL:{x:-s*amp*0.8,z:0.05},armR:{x:s*amp*0.8,z:-0.05},kneeL:{x:Math.max(0,-s)*1.0+0.05},kneeR:{x:Math.max(0,s)*1.0+0.05},torso:{x:lean},bob:Math.abs(Math.sin(ph*2))*0.04}; });
  return [idle,gait(1.0,0.5,0.08),gait(0.7,0.9,0.16)];
}
const blank=()=>({bob:0,lean:0,twist:0,side:0,hipL:0,hipR:0,knL:.05,knR:.05,arL:0,arR:0,elL:0,elR:0});
class Anim{
  constructor(rig){ this.j=rig.userData.j; this.t=0; this.walk=0; this.p=blank(); this.T=blank(); this.state='idle'; }
  update(dt,s){
    this.t+=dt; const T=this.T; const a=s.action; let rate=14;
    // rate=40 — deliberately the fastest blend of anything in this chain (default is
    // 14, even the punchiest reactions top out around 26) so a knockout SNAPS the
    // pose almost instantly regardless of what you were doing when it landed, instead
    // of slowly easing out of a mid-swing/mid-dodge extreme over the next several
    // frames — getting KO'd should read as an immediate, decisive cut, not a fade.
    if(!s.alive){ this.state='dead'; rate=40; T.lean=-0.15;T.bob=-0.15;T.hipL=-0.3;T.hipR=-0.3;T.knL=0.15;T.knR=0.15;T.arL=0.4;T.arR=0.4;T.twist=0;T.side=0; }
    else if(isAtk(a)){ this.state=a; rate=26; this.atk(a,s.ap,T); }
    else if(a==='block'){ this.state=a; T.lean=0.12;T.bob=-0.04;T.arL=-0.7;T.arR=-0.7;T.elL=1.5;T.elR=1.5;T.knL=0.35;T.knR=0.35;T.twist=0;T.side=0; }
    else if(a==='throw'){ this.state=a; rate=24; const k=Math.sin(Math.min(s.ap,1)*Math.PI); T.arR=-1.8*k;T.elR=0.3;T.arL=0.3*k;T.elL=0;T.lean=0.1*k;T.twist=-0.3*k;T.bob=0;T.knL=0.1;T.knR=0.1;T.side=0; }
    else if(a==='dodge'){ this.state=a; rate=22; const k=Math.sin(Math.min(s.ap,1)*Math.PI); T.lean=0.25*k;T.bob=-0.08*k;T.knL=0.6*k;T.knR=0.6*k;T.arL=-0.5;T.arR=-0.5;T.elL=1.1;T.elR=1.1;T.side=0;T.twist=0; }
    else if(a==='hit'){ this.state=a; rate=20; const k=1-Math.min(s.ap,1); T.lean=-0.35*k;T.bob=-0.03;T.twist=0.2*k;T.arL=0.5*k;T.arR=0.5*k;T.knL=0.2;T.knR=0.2;T.side=0;T.elL=0;T.elR=0; }
    // distinct from the small hit-flinch above — a bigger, arms-flailing "flung
    // backward" reaction, since a landed grab actually does throw you (real
    // knockback, see server/world.js's MOVES.grab.kb), not just stagger you in place
    else if(a==='grabbed'){ this.state=a; rate=18; const k=Math.sin(Math.min(s.ap,1)*Math.PI); T.lean=-0.5*k;T.bob=0.15*k;T.twist=0;T.side=0;T.arL=-0.8*k;T.arR=-0.8*k;T.elL=0.6*k;T.elR=0.6*k;T.knL=0.4*k;T.knR=0.4*k; }
    // symmetric — BOTH fighters play this at once (server/world.js's applyClash()),
    // so unlike hit's one-sided flinch or grabbed's fling, this is a braced, arms-out
    // recoil: both arms push forward/up as if the swing just bounced off something,
    // with a small backward lean from the (much gentler than a real hit's) knockback.
    else if(a==='clash'){ this.state=a; rate=24; const k=Math.sin(Math.min(s.ap,1)*Math.PI); T.lean=-0.2*k;T.bob=0;T.twist=0;T.side=0;T.arL=-1.2*k;T.arR=-1.2*k;T.elL=0.9*k;T.elR=0.9*k;T.knL=0.15;T.knR=0.15; }
    // stamina exhaustion (either pool, see shared/movement.js) — slower blend-in than
    // the punchier combat reactions above (a woozy settle, not a snap reaction), limp
    // drooping arms, and a continuous side-to-side sway (this.t, not s.ap-driven like
    // every other reaction here) for a dazed, off-balance read that's held the whole
    // stun rather than a one-shot curve.
    else if(a==='stunned'){ this.state=a; rate=10; const sway=Math.sin(this.t*3)*0.15;
      T.lean=0.15;T.bob=-0.02;T.twist=0;T.side=sway;T.arL=0.3;T.arR=0.3;T.elL=0.3;T.elR=0.3;T.knL=0.25;T.knR=0.25; }
    // held two-handed in front — a fixed stance (not blended with locomotion) since
    // shared/movement.js locks out every other move while carrying, matching how
    // block/throw/etc. are fixed poses too rather than leg-blended with movement.
    else if(s.carrying){ this.state='carry'; T.arL=-0.9;T.arR=-0.9;T.elL=1.3;T.elR=1.3;T.lean=0.05;T.bob=0;T.twist=0;T.side=0;T.knL=0.08;T.knR=0.08; }
    else { this.state=decideState(s.grounded,s.speed,s.vy); this.loco(dt,s,T); }
    const k=1-Math.exp(-rate*dt); for(const key in this.p) this.p[key]+=(this.T[key]-this.p[key])*k;
    this.apply();
  }
  loco(dt,s,T){
    if(s.speed<0.35){ const b=Math.sin(this.t*1.6); T.lean=0.02;T.bob=b*0.012;T.hipL=0;T.hipR=0;T.knL=0.06;T.knR=0.06;T.arL=b*0.03;T.arR=-b*0.03;T.twist=0;T.side=0;T.elL=0;T.elR=0; }
    else{ const run=THREE.MathUtils.clamp((s.speed-CFG.walk)/(CFG.run-CFG.walk),0,1); const st=THREE.MathUtils.lerp(0.55,1,run);
      this.walk+=dt*(5+s.speed*0.9); const w=Math.sin(this.walk);
      T.hipL=w*st;T.hipR=-w*st;T.arL=-w*st*0.85;T.arR=w*st*0.85;T.knL=Math.max(0,-w)*1.1+0.05;T.knR=Math.max(0,w)*1.1+0.05;
      T.bob=Math.abs(Math.sin(this.walk))*0.045;T.lean=0.06+run*0.14;T.twist=0;T.side=0;T.elL=0;T.elR=0; }
  }
  atk(a,ap,T){ const p=THREE.MathUtils.clamp(ap,0,1);
    if(a==='grab'){ const up=Math.min(p*2,1),down=Math.max(0,(p-0.5)*2),reach=-1.6*up+0.4*down;
      T.arL=reach;T.arR=reach;T.elL=0.15;T.elR=0.15;T.lean=0.15*up-0.1*down;T.bob=0;T.twist=0;T.side=0;T.knL=0.15;T.knR=0.15; return; }
    // superAttack ("Star Slam"): both arms raised overhead through the wind-up, then
    // slammed down together into a forward strike — deliberately its own distinct
    // silhouette (big two-armed overhead motion), not a bigger version of the
    // one-armed light/heavy swing below or grab's forward reach.
    if(a==='superAttack'){ const up=Math.min(p*1.82,1), down=Math.max(0,(p-0.55)*2.22);
      const arm=-2.4*up+3.2*down;
      T.arL=arm;T.arR=arm;T.elL=0.15;T.elR=0.15;T.lean=-0.3*up+0.6*down;T.bob=-0.08*down;T.twist=0;T.side=0;T.knL=0.3*up+0.05;T.knR=0.3*up+0.05; return; }
    const thrust=Math.sin(p*Math.PI),right=(a!=='light2'),big=(a==='heavy')?1.2:1,tw=(a==='heavy')?0.7:0.5;
    T.lean=0.08+0.14*thrust*big; T.knL=0.15;T.knR=0.15;
    if(right){ T.arR=-1.9*thrust*big;T.elR=0.25;T.arL=0.5*thrust;T.twist=-tw*thrust;T.side=0;T.elL=0; }
    else     { T.arL=-1.9*thrust*big;T.elL=0.25;T.arR=0.5*thrust;T.twist= tw*thrust;T.side=0;T.elR=0; }
    T.bob=0.03*thrust;
  }
  apply(){ const j=this.j,p=this.p;
    j.hips.position.y=1.0+p.bob; j.torso.rotation.set(p.lean,p.twist,p.side);
    j.legL.hp.rotation.x=p.hipL; j.legR.hp.rotation.x=p.hipR; j.legL.kn.rotation.x=p.knL; j.legR.kn.rotation.x=p.knR;
    j.armL.sh.rotation.x=p.arL; j.armR.sh.rotation.x=p.arR; j.armL.el.rotation.x=p.elL; j.armR.el.rotation.x=p.elR;
  }
}
export class ProceduralAnimator{
  constructor(scene,team){ this.obj=buildRig(team); scene.add(this.obj); this.a=new Anim(this.obj); this.kind='proc'; }
  update(dt,info){ this.a.update(dt,info); this.state=this.a.state; }
}

/* ---------------- model animator + factory ---------------- */
const CHAIN = {
  idle:['idle'], walk:['walk','run','idle'], run:['run','walk','idle'],
  jump:['jump','fall','run','idle'], fall:['fall','jump','idle'],
  light1:['light1','light2','heavy','idle'], light2:['light2','light1','heavy','idle'], light3:['light3','heavy','light1','idle'],
  heavy:['heavy','light3','idle'], grab:['grab','heavy','idle'], superAttack:['superAttack','grab','heavy','idle'],
  block:['block','idle'], throw:['throw','light1','idle'], dodge:['dodge','run','idle'],
  hit:['hit','idle'], grabbed:['grabbed','hit','idle'], clash:['clash','hit','idle'], dead:['dead','hit','idle'],
  carry:['carry','idle'], stunned:['stunned','hit','idle'],
};
// Continuous states repeat for as long as they hold; everything else (attacks,
// block, throw, hit, dead, the brief jump launch) plays once per entry and holds its
// last frame — otherwise three.js's default (LoopRepeat, infinite) replays an attack
// clip from frame 0 for as long as the game keeps you in that action. stunned is
// looping too, same reasoning as idle/walk/run/carry — it's meant to read as an
// ongoing daze for the whole (often multi-second) stun, not a one-shot reaction that
// freezes on its last frame partway through.
const LOOPING = new Set(['idle','walk','run','fall','carry','stunned']);
export class ModelAnimator{
  // Whether dying actually has a distinct reaction clip to show at all — CHAIN.dead
  // falls back to 'hit', then all the way to 'idle', if neither is mapped (see
  // resolve() below), which would otherwise render a knockout as the character just
  // standing there mid-idle-loop. render.js reads this to decide whether it needs to
  // apply its own fallback "topple over" tilt (already the built-in procedural rig's
  // only death cue) for a custom model too, instead of assuming a real clip exists.
  constructor(obj,mixer,actions){ this.obj=obj; this.mixer=mixer; this.actions=actions; this.current=null; this.kind='model'; this.state='idle'; this._lastAp=0;
    this.hasDeathReaction=!!(actions.dead||actions.hit); }
  resolve(st){ for(const s of (CHAIN[st]||[st])) if(this.actions[s]) return {action:this.actions[s], key:s}; return null; }
  // update() calls this every frame with whatever the CURRENT state is, not just on
  // change — so "already playing this action" alone isn't enough to skip a restart,
  // or a held one-shot state (an attack, block, ...) would reset to frame 0 forever.
  // "The nominal state changed" isn't the whole story either: light1/2/3 are 3
  // independently-bound attacks now (see shared/movement.js), so re-pressing the SAME
  // one back to back (mashing/holding one key) fires a genuinely new instance without
  // the state NAME ever changing — ap resetting to near zero (mirrors client/net.js's
  // aEl===0 check for the same underlying event) is the real "a fresh instance began"
  // signal. Must be a reset to near-ZERO specifically, not just any decrease: client-
  // side reconciliation (see net.js's _snapshot()) routinely snaps ap back by a small
  // amount every time an authoritative update arrives, before replaying pending
  // inputs — treating ANY dip as a restart re-triggers fadeIn() on practically every
  // network tick, which never lets weight climb past ~0 and looks like a permanent
  // T-pose. A small correction never approaches 0 mid-swing, so this stays immune to
  // it while still catching a genuine restart. A continuous loop keeps playing
  // untouched regardless of either signal.
  set(st,ap,fade=0.18){ const changed=st!==this.state;
    const restarted = ap!=null && ap<0.05 && this._lastAp>0.05; this._lastAp=ap??this._lastAp;
    this.state=st;
    const r=this.resolve(st); if(!r)return;
    const nx=r.action, loop=LOOPING.has(r.key);
    if(nx===this.current && ((!changed&&!restarted)||loop))return;
    nx.setLoop(loop?THREE.LoopRepeat:THREE.LoopOnce, loop?Infinity:1); nx.clampWhenFinished=!loop;
    nx.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if(this.current && this.current!==nx)this.current.fadeOut(fade); this.current=nx; }
  update(dt,info){
    let st; if(!info.alive)st='dead';
    else if(isAtk(info.action)||info.action==='block'||info.action==='throw'||info.action==='dodge'||info.action==='hit'||info.action==='grabbed'||info.action==='clash'||info.action==='stunned')st=info.action;
    else if(info.carrying)st='carry';
    else st=decideState(info.grounded,info.speed,info.vy);
    // A knockout gets a much shorter crossfade than every other transition (default
    // 0.18s) — same reasoning as the procedural rig's rate=40 above: dying should cut
    // to the dead pose almost immediately regardless of what was playing, not blend
    // out of a mid-swing/mid-dodge clip over the usual fade window. Not literally 0 —
    // a very short nonzero fade avoids a jarring same-frame pop.
    this.set(st,info.ap,st==='dead'?0.05:0.18);
    // Match playback rate to actual ground speed so a custom clip's stride doesn't
    // look like it's sliding relative to how far the character is really moving —
    // the procedural rig already does the equivalent (see Anim.loco's `this.walk+=
    // dt*(5+s.speed*0.9)`); the clip-based path never had it. Reference speed is
    // whatever CFG considers "nominal" for that locomotion state, so this stays
    // correct even if walk/run speeds get retuned later.
    if(this.current){
      if(st==='walk') this.current.timeScale=THREE.MathUtils.clamp(info.speed/CFG.walk,0.4,2.5);
      else if(st==='run') this.current.timeScale=THREE.MathUtils.clamp(info.speed/CFG.run,0.4,2.5);
      // attacks: MOVES[st].dur already IS the clip's native length divided by
      // speedMult (see recomputeMoveDur() in shared/constants.js) — playing the clip
      // at timeScale=speedMult is what makes it finish exactly when aEl reaches dur.
      // Leaving this at 1 (as before) meant a sped-up move's game-logic ended the
      // action before the clip had actually finished playing, aborting it mid-swing.
      else if(isAtk(st)) this.current.timeScale=MOVES[st].speedMult;
      else this.current.timeScale=1;
    }
    this.mixer.update(dt);
  }
}

// FBXLoader warns once per vertex that has more than 4 bone weights (a GPU skinning
// hardware limit — it already correctly keeps the 4 heaviest and drops the rest, this
// is just it saying so). That's a property of the source file, re-triggered on every
// single load since the loader has no cache — re-exporting the asset with weights
// limited to 4 per vertex (e.g. Blender's Weight Paint → Limit Total) is the real fix,
// but that's outside what this code can do. This only silences the known, benign
// message for the duration of this one load — anything else still logs normally.
// Same deal with "X map is not supported in three.js, skipping texture" (e.g.
// ShininessExponent, common on Mixamo-authored FBX materials) — a property of the
// source file's material setup that FBXLoader has no fix for either, just quietly
// drops the one texture slot it can't map and keeps going.
const BENIGN_FBX_WARNINGS=['more than 4 skinning weights','is not supported in three.js, skipping texture'];
async function quietly(loadFn){
  const orig=console.warn;
  console.warn=(...args)=>{ if(typeof args[0]==='string' && BENIGN_FBX_WARNINGS.some(w=>args[0].includes(w))) return; orig.apply(console,args); };
  try{ return await loadFn(); } finally{ console.warn=orig; }
}
// `name` carries the original filename for extension detection — `url` is often an
// opaque blob: URL (from URL.createObjectURL) with no extension of its own.
export async function loadAsset(url,name=url){
  const ext=name.split('?')[0].split('.').pop().toLowerCase();
  if(ext==='glb'||ext==='gltf'){ const { GLTFLoader }=await import('three/addons/loaders/GLTFLoader.js');
    const g=await new GLTFLoader().loadAsync(url); return { scene:g.scene, animations:g.animations||[] }; }
  if(ext==='fbx'){ const { FBXLoader }=await import('three/addons/loaders/FBXLoader.js');
    const f=await quietly(()=>new FBXLoader().loadAsync(url)); return { scene:f, animations:f.animations||[] }; }
  throw new Error('Unsupported: .'+ext);
}
function hexNum(h){ return typeof h==='string' ? parseInt(h.replace('#',''),16) : h; }
// Only clone+touch materials that actually support emissive tinting — cloning every
// material on every mesh regardless (the old behavior) meant 8 fighters × N meshes of
// wasted GPU program/uniform setup for materials the tint could never apply to anyway.
function applyTint(model,tint){ model.traverse(o=>{ if(!o.isMesh||!o.material)return;
  const mats=Array.isArray(o.material)?o.material:[o.material];
  let changed=false;
  const out=mats.map(m=>{ if(!m.emissive)return m; changed=true;
    // Rebuild as MeshLambertMaterial instead of m.clone() (which would keep whatever
    // expensive type the loaded model shipped with, e.g. Standard/Phong) — same map
    // and base color, much cheaper fragment shader across 8 fighters.
    const n=new THREE.MeshLambertMaterial({color:m.color,map:m.map||null});
    n.emissive.set(tint); n.emissiveIntensity=0.28; return n; });
  if(changed) o.material=Array.isArray(o.material)?out:out[0]; }); }

export class CharacterFactory{
  constructor(proto,clips,cfg,clone){ this.proto=proto; this.clips=clips; this.cfg=cfg||{}; this.clone=clone; }
  static async fromLoaded(proto,clipsByName,cfg){
    const { clone }=await import('three/addons/utils/SkeletonUtils.js');
    return new CharacterFactory(proto,clipsByName,cfg,clone);
  }
  create(scene,{tint}={}){
    const container=new THREE.Group();
    const model=this.clone(this.proto);
    model.rotation.y=this.cfg.yawOffset||0;
    model.position.y=this.cfg.groundOffset||0;   // rig's local origin often isn't at its feet (see studio.js groundOffset())
    const t=this.cfg.tint!=null?hexNum(this.cfg.tint):tint;   // a Studio-chosen tint wins over the auto palette color
    if(t!=null) applyTint(model,t);
    // fighters don't cast shadows in-match (perf: 8 dynamic casters is the costliest
    // part of the shadow pass) — the Studio preview keeps its own casting untouched,
    // since this only mutates the clone, not this.proto.
    // Frustum culling is already on by default here (never disabled on this path —
    // Studio's own preview turns it off in studio.js, but that's a separate object
    // graph, not this.proto). A SkinnedMesh's bounding sphere is computed once from
    // the bind pose though, so an animated pose (arms swinging, attack poses) can
    // visually extend past it and get incorrectly culled while still on-screen — pad
    // it generously as a safety margin. Guarded by a flag on the geometry itself since
    // SkeletonUtils.clone() shares geometry across every fighter using this factory;
    // without the guard each new clone would inflate the same shared sphere again.
    model.traverse(o=>{ if(!o.isMesh)return; o.castShadow=false;
      if(o.isSkinnedMesh){
        if(!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        if(!o.geometry.userData._paddedForCulling){ o.geometry.boundingSphere.radius+=1.2; o.geometry.userData._paddedForCulling=true; }
      }
    });
    container.add(model);
    const mixer=new THREE.AnimationMixer(model);
    const actions={};
    for(const s of ALLSTATES){ const key=(this.cfg.clips&&this.cfg.clips[s])||(this.cfg.animations&&this.cfg.animations[s])||s;
      const clip=this.clips[key]||this.clips[s]; if(clip) actions[s]=mixer.clipAction(clip); }
    const near=new ModelAnimator(container,mixer,actions);
    // A custom uploaded rig has no lower-poly version of itself (see LOD_DISTANCE
    // below for why that'd need a second, externally-decimated skinned asset rather
    // than an automatic in-browser simplify — three.js's SimplifyModifier drops
    // skinIndex/skinWeight entirely, so it can't touch a rigged mesh without breaking
    // its animation). The built-in procedural rig is already cheap, already animated,
    // and already the game's fallback when there's no custom character at all — reuse
    // it as the "far" representation instead of inventing a new asset pipeline.
    const far=new ProceduralAnimator(scene,t!=null?t:paletteColor(0));
    return new LODAnimator(scene,near,far);
  }
}

// Infinity: the custom model should always be what's shown, at any distance — no
// automatic swap to the built-in procedural rig for distant fighters. This was
// previously a real (20-unit) threshold purely for performance — reducing rendering
// cost for fighters far from the camera without affecting a close-range fight — but
// per direct request, the far level is now unreachable at any real in-game distance,
// so LODAnimator's "near" (custom model) level is what always ends up selected.
// Reintroducing a finite distance here is the way back if performance ever calls for it.
const LOD_DISTANCE=Infinity;

// Swaps between a near (full custom model, real skeleton/clips) and far (built-in
// procedural rig) representation based on camera distance. THREE.LOD hides every
// level except the current one, so only the visible level's meshes submit triangles —
// the invisible level is also skipped here rather than ticked for nothing.
export class LODAnimator{
  constructor(scene,near,far){
    this.lod=new THREE.LOD();
    this.lod.addLevel(near.obj,0);
    this.lod.addLevel(far.obj,LOD_DISTANCE);
    this.near=near; this.far=far; this.obj=this.lod; this.kind='model';
    scene.add(this.lod);
  }
  update(dt,info){
    // Superstar mode forces the near (full-detail) level visible regardless of actual
    // camera distance (render.js's syncFighter skips this.lod.update(camera) entirely
    // while active, to avoid fighting that override) — so getCurrentLevel() can be
    // stale here, still reporting "far" from before activation. Ticking by that stale
    // value would animate the HIDDEN far rig while the visible near model's mixer
    // never advances for the whole buff — tick whichever level is actually on screen.
    if(info.superstarActive || this.lod.getCurrentLevel()===0) this.near.update(dt,info);
    else this.far.update(dt,info);
  }
}
