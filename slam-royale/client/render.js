// Rendering + world + FX. Delegates all character animation to character.js, so it
// can draw the procedural rig or a loaded GLTF/FBX model interchangeably. There is
// ONE shared character look for the whole game — the admin's default, fetched from
// the server — used for every fighter (local and remote alike) that doesn't have its
// own factory. Only the admin, entering a match from inside the Studio, has one of
// those (their in-progress edit, for instant preview).

import * as THREE from 'three';
import { ProceduralAnimator, CharacterFactory, paletteColor, loadAsset, buildSampleRig, buildSampleClips } from './character.js';
import { getDefaultCharacter, getModelFile, getAnimFile } from './character-sync.js';
import { CFG } from '../shared/constants.js';

const stripRootTracks=clip=>{ clip.tracks=clip.tracks.filter(t=>!/(Hips|hips|root|Root)\.position$/.test(t.name)); return clip; };

// ---------------- arena scenery (gladiator stadium) ----------------
// Perf rules carried over from the GPU-bound-frametime pass earlier: no new dynamic
// lights (each one multiplies fragment cost across every lit surface, fighters
// included — the dominant existing cost), no shadow casters (shadows are off
// entirely, see the View constructor), cheap unlit materials for anything that's
// just background dressing, and every REPEATED prop (pillars, banners) drawn as one
// InstancedMesh instead of N separate meshes/draw calls. All textures are baked once
// via <canvas>, same technique the original grid floor already used — no image
// assets to fetch or decode.
function buildStadiumWallTexture(){
  const c=document.createElement('canvas'); c.width=512; c.height=256; const g=c.getContext('2d');
  const grad=g.createLinearGradient(0,256,0,0);
  grad.addColorStop(0,'#241d18'); grad.addColorStop(0.55,'#4a3a2c'); grad.addColorStop(1,'#7a6146');
  g.fillStyle=grad; g.fillRect(0,0,512,256);
  g.strokeStyle='rgba(0,0,0,.35)'; g.lineWidth=2;
  for(let i=1;i<8;i++){ const y=256-i*32; g.beginPath(); g.moveTo(0,y); g.lineTo(512,y); g.stroke(); }
  g.fillStyle='rgba(15,12,10,.55)';
  for(let i=0;i<1400;i++) g.fillRect(Math.random()*512, 30+Math.random()*190, 2, 3);   // scattered "crowd" texture
  const tex=new THREE.CanvasTexture(c); tex.wrapS=THREE.RepeatWrapping; tex.repeat.set(8,1);
  return tex;
}
function buildFloorTexture(){
  const c=document.createElement('canvas'); c.width=c.height=512; const g=c.getContext('2d');
  g.fillStyle='#8f7c60'; g.fillRect(0,0,512,512);
  const tiles=8, size=512/tiles;
  for(let ty=0;ty<tiles;ty++) for(let tx=0;tx<tiles;tx++){
    g.fillStyle=`rgba(0,0,0,${Math.random()*0.12})`; g.fillRect(tx*size,ty*size,size,size);
  }
  g.strokeStyle='rgba(0,0,0,.28)'; g.lineWidth=3;
  for(let i=0;i<=tiles;i++){ const v=i*size; g.beginPath(); g.moveTo(v,0);g.lineTo(v,512);g.moveTo(0,v);g.lineTo(512,v);g.stroke(); }
  const tex=new THREE.CanvasTexture(c); tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(20,20); tex.anisotropy=2;
  return tex;
}
function buildBannerTexture(){
  const c=document.createElement('canvas'); c.width=128; c.height=256; const g=c.getContext('2d');
  g.fillStyle='#7a1f22'; g.fillRect(0,0,128,256);
  g.fillStyle='#ffb020'; g.fillRect(0,86,128,16); g.fillRect(0,154,128,16);
  g.fillStyle='#1a1205'; g.beginPath(); g.arc(64,60,26,0,Math.PI*2); g.fill();
  return new THREE.CanvasTexture(c);
}
function buildGlowTexture(){
  const c=document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d');
  const grad=g.createRadialGradient(32,32,0,32,32,32);
  grad.addColorStop(0,'rgba(255,205,130,.9)'); grad.addColorStop(0.4,'rgba(255,140,60,.35)'); grad.addColorStop(1,'rgba(255,140,60,0)');
  g.fillStyle=grad; g.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(c);
}

// The throwable item, in every form it takes: sitting on the ground, held in a
// fighter's hands, and in flight — same shape throughout so it visibly reads as
// "the same object" across its whole lifecycle. Cheap unlit primitives (a squat
// cylinder + two darker cylinder "bands"), matching the rest of the pickups' style.
function buildBarrel(scale=1){
  const g=new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.26,0.5,12), new THREE.MeshBasicMaterial({color:0x8a5a2b})));
  const bandMat=new THREE.MeshBasicMaterial({color:0x2a1f14});
  for(const y of [0.16,-0.16]){ const b=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.28,0.06,12), bandMat); b.position.y=y; g.add(b); }
  g.scale.setScalar(scale);
  return g;
}

// on: bright gold, overriding whatever team-tint color is normally there. off: back to
// the tint baseline (0.28 — see character.js's applyTint/CharacterFactory, the only
// other place that sets this) — same materials either way, just the emissive numbers.
function setGlow(obj,on){ obj.traverse(o=>{ if(!o.isMesh||!o.material) return;
  const mats=Array.isArray(o.material)?o.material:[o.material];
  for(const m of mats){ if(!m.emissive) continue;
    // team tint varies per fighter, so the only reliable way back to it is caching
    // whatever was actually there right before we override it gold, not a hardcoded color.
    if(on){ if(!m._tintEmissive) m._tintEmissive=m.emissive.clone(); m.emissive.setHex(0xffee66); m.emissiveIntensity=1.4; }
    else { if(m._tintEmissive) m.emissive.copy(m._tintEmissive); m.emissiveIntensity=0.28; } } }); }

// Frees every GPU-side resource under `root` — renderer.dispose() alone only
// releases the renderer's OWN internal caches, not geometries/materials/textures it
// was never given explicit ownership of. Shared by View.dispose() (a whole scene at
// once, at match end) and disposeFighterEarly() (one fighter's own object, when it's
// actually safe to — see that method's comment). THREE.Sprite is skipped: its
// default geometry (when none is explicitly passed to its constructor) is a
// module-level singleton shared across every Sprite on the page, not something any
// one View/fighter owns — disposing it here would corrupt sprites everywhere else.
function disposeObjectTree(root){
  const disposeTexturesOf=mat=>{ for(const k in mat){ const v=mat[k]; if(v&&v.isTexture)v.dispose(); } };
  root.traverse(o=>{
    if(o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
    if(o.geometry && !o.isSprite) o.geometry.dispose();
    const mats=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
    for(const mat of mats){ disposeTexturesOf(mat); mat.dispose(); }
  });
}

// Builds the one CharacterFactory shared by everyone in the match, from whatever the
// admin has saved as the game's default character. Returns null if none is set (or
// it fails to load), in which case fighters render with the built-in procedural rig.
async function loadSharedDefaultFactory(){
  let data; try{ data=await getDefaultCharacter(); }catch(e){ console.error('could not reach the default character:',e); return null; }
  if(!data || !data.model) return null;
  try{
    const clips={};
    // The model fetch (when not the built-in sample) and every external animation
    // fetch are independent network requests, previously awaited one at a time in a
    // for-loop — each file's download+parse time added up back-to-back instead of
    // overlapping. A character with many clips (especially large ones — an
    // animation-only FBX export that accidentally embeds the full mesh+skin+texture
    // data, a known Mixamo export pitfall, can be tens of MB instead of under 1MB;
    // see the size warning in studio.js's addAnim()) turns that sum into a very long
    // "loading" wait for every single player joining the match. Running them all
    // concurrently instead means the wall-clock cost is whichever single file is
    // slowest, not the sum of all of them.
    const modelP = data.model.kind==='sample' ? null
      : getModelFile().then(f=>loadAsset(URL.createObjectURL(f),f.name));
    const animsP = Promise.all((data.anims||[]).map(async name=>{
      const file=await getAnimFile(name);
      const a=await loadAsset(URL.createObjectURL(file),file.name);
      const clip=a.animations[0]; if(!clip) return null;
      if(data.strip!==false) stripRootTracks(clip);
      return {name,clip};
    }));
    const [modelResult,animResults] = await Promise.all([modelP,animsP]);
    let base;
    if(data.model.kind==='sample'){ base=buildSampleRig(); for(const c of buildSampleClips()) clips[c.name]=c; }
    else{ base=modelResult.scene; for(const c of modelResult.animations) clips[c.name]=c; }
    for(const r of animResults) if(r) clips[r.name]=r.clip;
    // One-time, per-instance triangle count (independent of camera distance, fighter
    // count, or animation state) — isolates whether the uploaded asset itself is
    // high-poly, as opposed to the per-frame renderer.info total which also reflects
    // how many fighters happen to be in frustum at once.
    let tris=0; base.traverse(o=>{ if(o.isMesh&&o.geometry){ const g=o.geometry;
      tris += g.index ? g.index.count/3 : g.attributes.position.count/3; } });
    console.log(`[perf] default character model: ${Math.round(tris).toLocaleString()} tris/instance (×N fighters on screen = renderer.info's per-frame total)`);
    base.scale.setScalar(data.scale||1);
    const cfg={ yawOffset:data.yaw, groundOffset:data.groundOffset, tint:data.tint, clips:{}, animations:{} };
    for(const [state,a] of Object.entries(data.assign||{})) (a.source==='embedded'?cfg.clips:cfg.animations)[state]=a.name;
    return await CharacterFactory.fromLoaded(base,clips,cfg);
  }catch(e){ console.error('failed to build the default character:',e); return null; }
}

class Cam{
  constructor(c){ this.cam=c; this.yaw=Math.PI; this.pitch=0.32; this.pos=new THREE.Vector3(); this.first=true; this.shake=0; }
  add(m){ this.shake=Math.min(1,this.shake+m); }
  update(dt,mouse,target){
    // Pitch clamp: -0.1 used to barely let you look up at all (only ~5.7°) while
    // still allowing a full ~63° of look-down — camera Y is target.y+1.7+sin(pitch)*6,
    // so the floor (further negative pitch swings the camera BELOW the target,
    // eventually clipping into the ground) is the actual limit here, not an arbitrary
    // choice — -0.22 keeps a comfortable margin above y=0 even in the worst case
    // (grounded, target.y=0) while giving noticeably more look-up range than before.
    this.yaw-=mouse.x*0.0026; this.pitch=THREE.MathUtils.clamp(this.pitch+mouse.y*0.0022,-0.22,1.1);
    const cp=Math.cos(this.pitch);
    const want=new THREE.Vector3(target.x+Math.sin(this.yaw)*cp*6.0, target.y+1.7+Math.sin(this.pitch)*6.0, target.z+Math.cos(this.yaw)*cp*6.0);
    // Snappy follow (~35ms time constant) so the camera stays attached to the player
    // without feeling rigid — "never fights the player" — rather than visibly lagging.
    const k=this.first?1:1-Math.exp(-26*dt); this.first=false; this.pos.lerp(want,k);
    this.shake*=Math.exp(-9*dt); const s=this.shake*0.35;
    this.cam.position.set(this.pos.x+(Math.random()-.5)*s,this.pos.y+(Math.random()-.5)*s,this.pos.z+(Math.random()-.5)*s);
    this.cam.lookAt(target.x,target.y+1.7,target.z);
  }
}

export class View{
  constructor(container){
    // Perf over fidelity: no AA, no supersampling on hi-DPI screens, and no shadow pass
    // at all — a second full scene render from the light's viewpoint is usually the
    // single biggest GPU cost in a scene with 8 animated (and, now that the blob-URL
    // load bug is fixed, actually rendering) skinned-mesh fighters.
    this.renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1)); this.renderer.setSize(innerWidth,innerHeight);
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure=1.05; this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene=new THREE.Scene(); this.camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,0.1,400);
    this.cam=new Cam(this.camera);
    this._buildWorld();
    this.fighters=new Map();          // id -> { animator, kind }
    this.impacts=[]; this.colorIx=new Map(); this.nextColor=0;
    this.localFactory=null;           // set only when the admin enters a match from inside the Studio (their in-progress edit)
    this.sharedFactory=null;          // the game-wide default, used by everyone else (and remotes, always)
    // Exposed so main.js can await it before ever revealing the match — otherwise
    // fighters render with the placeholder procedural rig until this resolves, then
    // pop to the real model mid-game (see ensureFighter()'s "upgrade" path below).
    // Always resolves (never rejects) — loadSharedDefaultFactory() catches its own
    // failures and resolves to null, falling back to the procedural rig either way.
    this.sharedFactoryPromise = loadSharedDefaultFactory().then(f=>{ this.sharedFactory=f; return f; });
    this.onLocalCharError=null;       // optional hook: (err)=>void, called when the LOCAL player's custom character fails
    this._resize=()=>{ this.camera.aspect=innerWidth/innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth,innerHeight); };
    addEventListener('resize',this._resize);
  }
  // Walks the scene and frees every GPU-side resource in it — renderer.dispose()
  // alone only releases the renderer's OWN internal caches, not geometries/materials/
  // textures it was never given explicit ownership of. Without this, every full view
  // teardown (leaving a match, returning to menu, an abandoned lobby preload — see
  // main.js's startPreload()) leaked the ENTIRE scene's GPU memory every time: the
  // arena's baked canvas textures and InstancedMesh geometries, every fighter's own
  // geometry/skinned-mesh data, all of it — accumulating with every match played in
  // the same browser session, a real (if gradual, session-over-time) contributor to
  // "frame rate keeps getting worse." Confirmed safe against loadSharedDefaultFactory()
  // (called fresh per View, never cached across instances — each View's own geometry
  // is exclusively its own) — the one exception is THREE.Sprite (the torch glows),
  // which falls back to a single geometry shared across EVERY Sprite on the page (a
  // three.js internal, not something this app owns per-View), skipped below so
  // disposing one View's torches can't corrupt another's.
  dispose(){
    removeEventListener('resize',this._resize);
    disposeObjectTree(this.scene);
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
  // A fighter leaving mid-match (disconnect, or giving up on a broken sync after
  // bounded retries — see syncFighter()'s catch and removeMissing() below) used to
  // just scene.remove() its object and stop, same gap View.dispose() above used to
  // have before it was fixed, just at per-fighter granularity instead of per-match.
  // NOT safe to blanket-fix the same way, though: a model-kind fighter's "near" LOD
  // level is a SkeletonUtils.clone() of the shared factory's proto (see character.js's
  // CharacterFactory.create() — "SkeletonUtils.clone() shares geometry across every
  // fighter using this factory") — disposing its geometry here would corrupt every
  // OTHER fighter still rendering with that same uploaded character, not just free
  // this one's memory. Only ever safe to fully dispose a procedural-kind fighter
  // (buildRig() constructs brand new geometry every call, never shared) — for a
  // model-kind one, only its LOD "far" level is safe (LODAnimator always builds that
  // procedural fallback fresh per fighter too); the shared "near" model is left for
  // the eventual full View.dispose() at match end to clean up together with
  // everyone else still using it.
  disposeFighterEarly(f){
    if(f.kind==='proc') disposeObjectTree(f.animator.obj);
    else if(f.animator.far) disposeObjectTree(f.animator.far.obj);
  }
  setLocalFactory(f){ this.localFactory=f; }

  _buildWorld(){
    const scene=this.scene;
    // Dusk arena palette (warm horizon, deep sky) instead of the old flat 2-tone sky —
    // same single-draw-call gradient-sphere shader as before, just retuned colors, so
    // this is a free visual upgrade (zero added cost) that also sets up the torch-glow
    // sprites below to actually read against a darker backdrop.
    const sky=new THREE.Mesh(new THREE.SphereGeometry(200,32,16),new THREE.ShaderMaterial({side:THREE.BackSide,
      uniforms:{top:{value:new THREE.Color(0x171226)},bot:{value:new THREE.Color(0xd98a4f)}},
      vertexShader:`varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`varying vec3 p;uniform vec3 top;uniform vec3 bot;void main(){float h=normalize(p).y*.5+.5;gl_FragColor=vec4(mix(bot,top,pow(h,.75)),1.);}`}));
    scene.add(sky); scene.fog=new THREE.Fog(0x6b5240,45,150);

    // Floor: same single PlaneGeometry as before, but MeshLambertMaterial instead of
    // MeshStandardMaterial (the earlier GPU-bound-frametime fix downgraded the
    // character materials for exactly this reason — a big screen-covering plane with
    // PBR roughness/specular is real per-fragment cost for no visual payoff at this
    // camera distance) and a stone-tile texture instead of the bare grid.
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(320,320),new THREE.MeshLambertMaterial({map:buildFloorTexture()}));
    floor.rotation.x=-Math.PI/2; scene.add(floor);

    // Stadium wall: ONE open cylinder ringing the arena, textured with baked tiered-
    // seating + crowd bands (see buildStadiumWallTexture) — reads as a full colosseum
    // from playing distance for the cost of a single low-segment-count mesh. Unlit
    // (MeshBasicMaterial): it's background dressing, not something worth spending a
    // lighting computation on, and looks fine since the shading is already baked into
    // the texture's gradient.
    const wallR=58;
    const wall=new THREE.Mesh(new THREE.CylinderGeometry(wallR,wallR+4,34,28,1,true),
      new THREE.MeshBasicMaterial({map:buildStadiumWallTexture(),side:THREE.BackSide,fog:true}));
    wall.position.y=15; scene.add(wall);

    // Pillars ringing the inside of the wall — ONE InstancedMesh, so the draw-call/
    // memory cost is the same whether there are 4 or 40 of them.
    const pillarCount=14, pillarR=52;
    const pillarGeo=new THREE.CylinderGeometry(1.1,1.3,12,8);
    const pillars=new THREE.InstancedMesh(pillarGeo,new THREE.MeshLambertMaterial({color:0x8c7f6e}),pillarCount);
    const m=new THREE.Matrix4();
    for(let i=0;i<pillarCount;i++){
      const a=(i/pillarCount)*Math.PI*2;
      m.setPosition(Math.cos(a)*pillarR,6,Math.sin(a)*pillarR);
      pillars.setMatrixAt(i,m);
    }
    pillars.instanceMatrix.needsUpdate=true;   // required after setMatrixAt() or the GPU buffer never gets the new transforms
    scene.add(pillars);

    // Banners on every other pillar — a second InstancedMesh, same reasoning.
    const bannerTex=buildBannerTexture();
    const bannerGeo=new THREE.PlaneGeometry(2.2,4.4);
    const banners=new THREE.InstancedMesh(bannerGeo,new THREE.MeshBasicMaterial({map:bannerTex,side:THREE.DoubleSide}),Math.ceil(pillarCount/2));
    let bi=0;
    for(let i=0;i<pillarCount;i+=2){
      const a=(i/pillarCount)*Math.PI*2, x=Math.cos(a)*pillarR, z=Math.sin(a)*pillarR;
      m.makeRotationY(a+Math.PI/2); m.setPosition(x*0.94,7,z*0.94);
      banners.setMatrixAt(bi++,m);
    }
    banners.instanceMatrix.needsUpdate=true;
    scene.add(banners);

    // Torch glow: additive-blended billboard sprites on alternating pillar tops —
    // fakes torchlight ambiance without adding real scene lights (which would cost
    // real per-fragment lighting work on every surface, fighters included — the thing
    // the earlier GPU pass specifically cut down on). Sprites are camera-facing,
    // unlit, and about as cheap as a draw call gets, so a handful of individual ones
    // isn't worth instancing.
    const glowTex=buildGlowTexture();
    for(let i=0;i<pillarCount;i+=2){
      const a=(i/pillarCount)*Math.PI*2;
      const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,blending:THREE.AdditiveBlending,depthWrite:false,fog:true}));
      spr.position.set(Math.cos(a)*pillarR,12.5,Math.sin(a)*pillarR); spr.scale.setScalar(5);
      scene.add(spr);
    }

    scene.add(new THREE.HemisphereLight(0xc3a98a,0x2a2018,0.8));
    const sun=new THREE.DirectionalLight(0xffb27a,2.2); sun.position.set(14,22,9);
    scene.add(sun);
  }
  _color(id){ if(!this.colorIx.has(id)) this.colorIx.set(id,this.nextColor++); return paletteColor(this.colorIx.get(id)); }
  _reportCharError(e,isLocal){
    console.error(`${isLocal?'local':'remote'} character failed, falling back to the default fighter:`, e);
    if(isLocal) this.onLocalCharError?.(e);
  }

  ensureFighter(id,char,isLocal){
    const factory = isLocal ? (this.localFactory||this.sharedFactory) : this.sharedFactory;
    let f=this.fighters.get(id);
    if(f){
      // Upgrade procedural → model once the factory is ready — but only ever ATTEMPT
      // this once per fighter (upgradeFailed latch). Without it, a factory.create()
      // that throws (bad clip/skeleton data in the admin's uploaded character, etc.)
      // retries this same expensive rebuild — a full model clone + AnimationMixer +
      // up to 18 clip bindings, PLUS an entire second procedural rig for the LOD "far"
      // level (see LODAnimator's constructor) — on literally EVERY frame forever, with
      // the old objects removed from the scene but never .dispose()d (three.js doesn't
      // free GPU geometry/material memory on remove() alone). That combination is a
      // real, previously-latent bug: a continuously-worsening framerate collapse plus
      // a GPU memory leak, from a single failed attempt.
      if(factory && f.kind!=='model' && !f.upgradeFailed){
        // f.kind!=='model' here means it's the procedural rig being replaced —
        // always uniquely-owned geometry (buildRig() never shares), safe to fully free.
        this.scene.remove(f.animator.obj); this.disposeFighterEarly(f);
        try{ f={animator:factory.create(this.scene,{tint:this._color(id)}),kind:'model'}; }
        catch(e){ this._reportCharError(e,isLocal); f={animator:new ProceduralAnimator(this.scene,this._color(id)),kind:'proc',upgradeFailed:true}; }
        this.fighters.set(id,f);
      }
      return f.animator;
    }
    let animator,kind;
    if(factory){ try{ animator=factory.create(this.scene,{tint:this._color(id)}); kind='model'; }
      catch(e){ this._reportCharError(e,isLocal); animator=new ProceduralAnimator(this.scene,this._color(id)); kind='proc'; } }
    else { animator=new ProceduralAnimator(this.scene,this._color(id)); kind='proc'; }
    this.fighters.set(id,{animator,kind}); return animator;
  }
  // wrapped defensively: a broken model-based fighter (bad clip/bone data surfacing only
  // during playback, not construction) must never take down the whole render loop — see
  // main.js's loop(), which has no top-level catch of its own around this call.
  syncFighter(id,tr,info,dt,char,isLocal){
    const edt=info.hitstop>0?0:dt;   // hit pause: dt=0 is a harmless no-op for both animator implementations
    let anim,f;
    try{
      anim=this.ensureFighter(id,char,isLocal); f=this.fighters.get(id);
      anim.obj.position.set(tr.x,tr.y,tr.z); anim.obj.rotation.y=tr.rotY;
      // Custom-model fighters are wrapped in a real THREE.LOD (see character.js) that
      // swaps to the cheap built-in procedural rig once far enough from the camera —
      // recompute which level is current before ticking anything, using last frame's
      // camera position (render() updates the camera after all fighters are synced;
      // a one-frame-stale distance is imperceptible for a level swap). Superstar mode
      // is meant to make you a visible, marked target at any range — force the near
      // (full-detail) level instead of letting distance downgrade it.
      if(anim.obj.isLOD){
        if(info.superstarActive) anim.obj.levels.forEach((lv,i)=>{ lv.object.visible=(i===0); });
        else anim.obj.update(this.camera);
      }
      // Same "marked target" tell, the other half: override emissive to a bright gold
      // glow while active (covers both the procedural rig and any custom model, since
      // both already carry an emissive-capable material for team tinting), instead of
      // whatever team color it'd normally show — only touched on an actual state
      // change, not every frame.
      if(f.superstarVisual!==!!info.superstarActive){ f.superstarVisual=!!info.superstarActive; setGlow(anim.obj,f.superstarVisual); }
      // The carried barrel: attached once as a child of the fighter's root (so it
      // inherits position/facing for free) at a fixed offset approximating where the
      // 'carry' pose's bent-forward arms hold it — not true per-bone attachment (no
      // IK here), just a static offset tuned against the procedural rig's proportions,
      // reasonable for typical custom humanoid models too.
      if(!f.carryBarrel){ f.carryBarrel=buildBarrel(); f.carryBarrel.position.set(0,1.2,0.25); anim.obj.add(f.carryBarrel); }
      f.carryBarrel.visible=!!info.carrying;
      // The procedural rig has no real "dead" clip at all — this tilt IS its entire
      // death cue, always applied. A custom model normally shows its own mapped
      // dead/hit clip instead and doesn't need this on top (would double up with an
      // already-prone pose) — except when NEITHER is mapped (hasDeathReaction), or
      // one IS mapped but throws whenever it's actually played (deathAnimFailed,
      // set below — a clip existing is no guarantee it works, e.g. bone names
      // authored for a different skeleton). Either way the character would
      // otherwise just freeze exactly where it was with no death cue at all.
      const noDeathClip = f.kind==='model' && anim.near && (anim.near.hasDeathReaction===false || f.deathAnimFailed);
      const targetTilt=(!info.alive && (f.kind==='proc' || noDeathClip))?-1.35:0;
      anim.obj.rotation.x=THREE.MathUtils.lerp(anim.obj.rotation.x,targetTilt,1-Math.exp(-7*edt));
    }catch(e){
      this._reportCharError(e,isLocal);
      // Bounded retries only — deleting the fighter unconditionally here bypassed
      // ensureFighter()'s upgradeFailed latch entirely (a deleted fighter looks
      // "brand new" next frame, so a deterministic per-frame throw anywhere in this
      // try block re-enters the exact same catastrophic full-rebuild-every-frame loop
      // the latch above exists to prevent). After a few failed attempts, stop
      // touching this fighter at all: whatever's already in the scene just stays
      // frozen in its last-good state instead of being torn down and rebuilt forever.
      const n=((this._syncFailCount ||= new Map()).get(id)||0)+1; this._syncFailCount.set(id,n);
      const cur=this.fighters.get(id); if(cur && n<=3){ this.scene.remove(cur.animator.obj); this.disposeFighterEarly(cur); this.fighters.delete(id); }
      return;
    }
    // Animation update is isolated from the block above on purpose: position/LOD
    // level/glow/barrel visibility already succeeded by this point and should stick —
    // a single bad clip (e.g. a custom character's uploaded "throw" animation whose
    // keyframe tracks target bone names this particular skeleton doesn't have — a
    // real, common mismatch when a clip was authored against a different rig) can
    // make mixer.update()/AnimationAction.play() throw on every single attempt to
    // play THAT clip specifically, while every other state (idle/walk/attacks) keeps
    // working fine. Catching that here means it just skips animating for a frame
    // (the fighter still tracks position/rotation correctly, not visually stuck in
    // place) instead of tearing down and rebuilding a fighter that's otherwise
    // perfectly healthy, or permanently freezing it via the bounded-retry path above
    // for a failure that was never about fighter CREATION in the first place.
    try{
      // Animation update-RATE throttle (distinct from the LOD above, which is about
      // geometry): remotes are already smoothed by network interpolation, so their
      // animation doesn't need full-rate blending — update at half rate (compensating
      // dt on the frames that do run) to roughly halve animation CPU cost as player
      // count grows. The local player always updates at full rate — that's the one
      // that must feel instantly responsive.
      if(isLocal) anim.update(edt,info);
      else{ f.lodSkip=!f.lodSkip; if(f.lodSkip) anim.update(edt*2,info); }
    }catch(e){
      // Log once per fighter, not every frame — a deterministic clip failure (see
      // above) would otherwise throw here on every single frame forever and spam the
      // console into uselessness. Deliberately a different message from
      // _reportCharError's: the model itself is fine and still rendering (position/
      // LOD/glow all succeeded above) — it's specifically animating some state that's
      // failing, most likely one uploaded clip whose bone names don't match this rig.
      if(!f.animErrorLogged){ f.animErrorLogged=true;
        console.error(`${isLocal?'local':'remote'} character's animation update failed for state "${info.action}" — model is still visible but may be frozen mid-pose (likely a clip authored for a different skeleton):`, e); }
      // A mapped-but-broken dead/hit clip (bone names that don't match this
      // skeleton — the exact case above) throws EVERY frame, not just once, so
      // hasDeathReaction alone can't tell "a clip exists" from "a clip actually
      // plays." Once death specifically has failed to animate, flag it so the
      // fallback tilt below kicks in a frame late instead of never — silently
      // freezing mid-pose forever reads as far more broken than one late frame.
      if(!info.alive) f.deathAnimFailed=true;
    }
  }
  removeMissing(ids){ for(const id of this.fighters.keys()) if(!ids.has(id)){ const f=this.fighters.get(id); this.scene.remove(f.animator.obj); this.disposeFighterEarly(f); this.fighters.delete(id); this._syncFailCount?.delete(id); } }
  fighterObj(id){ const f=this.fighters.get(id); return f?f.animator.obj.position:null; }

  // Items/orbs are a fixed count for the whole match (see server/world.js's reset()) —
  // build their meshes once, lazily, then just move/show-hide them every snapshot.
  // Projectiles come and go dynamically, keyed by the server's stable per-throw id.
  syncWorldItems(items,orbs,projectiles,dt){
    if(!this._itemMeshes) this._itemMeshes=items.map(()=>{
      const m=buildBarrel(); m.position.y=0.9; this.scene.add(m); return m; });
    items.forEach((it,i)=>{ const m=this._itemMeshes[i]; if(!m)return;
      m.position.x=it.x; m.position.z=it.z; m.visible=!!it.a; m.rotation.y+=dt*1.4; });

    if(!this._orbMeshes) this._orbMeshes=orbs.map(()=>{
      const m=new THREE.Mesh(new THREE.IcosahedronGeometry(0.4,0),new THREE.MeshBasicMaterial({color:0xffee66}));
      m.position.y=1.1; this.scene.add(m); return m; });
    orbs.forEach((o,i)=>{ const m=this._orbMeshes[i]; if(!m)return;
      m.position.x=o.x; m.position.z=o.z; m.visible=!!o.a; m.rotation.y+=dt*2.0; });

    if(!this._projMeshes) this._projMeshes=new Map();
    const seen=new Set();
    for(const p of projectiles){ seen.add(p.id); let m=this._projMeshes.get(p.id);
      if(!m){ m=buildBarrel(); this.scene.add(m); this._projMeshes.set(p.id,m); }
      m.position.set(p.x,p.y,p.z); m.rotation.x+=dt*10; }   // tumbling end-over-end in flight
    for(const [id,m] of this._projMeshes) if(!seen.has(id)){ this.scene.remove(m); this._projMeshes.delete(id); }
  }

  // Trajectory indicator: shown only while the LOCAL player is aiming (Q held with an
  // item carried — see shared/movement.js's b.aiming). Simulates the SAME ballistic
  // physics the actual thrown projectile uses (server/world.js's throw spawn +
  // updateProjectiles: same spawn offset, same throwSpeed/throwUpSpeed/gravity, and now
  // the same camera-pitch launch-angle adjustment — see CFG.throwPitchInfluence) purely
  // client-side for preview — always exactly accurate to what pressing E right now
  // would do, never a separate approximation that could drift out of sync with it.
  // Only ever computed for the local player; remotes never show one.
  updateTrajectory(x,y,z,rotY,pitch,aiming){
    if(!aiming){ if(this._trajLine){ this._trajLine.visible=false; this._trajMarker.visible=false; } return; }
    const MAX_PTS=60;
    if(!this._trajLine){
      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PTS*3),3));
      const mat=new THREE.LineDashedMaterial({color:0xffcc55,dashSize:0.35,gapSize:0.25,transparent:true,opacity:0.9});
      this._trajLine=new THREE.Line(geo,mat); this._trajLine.frustumCulled=false; this.scene.add(this._trajLine);
      // flat ring on the ground at the predicted landing point — a bare line alone is
      // hard to judge an exact landing spot from at a glance
      this._trajMarker=new THREE.Mesh(new THREE.RingGeometry(0.35,0.5,20),
        new THREE.MeshBasicMaterial({color:0xffcc55,transparent:true,opacity:0.8,side:THREE.DoubleSide}));
      this._trajMarker.rotation.x=-Math.PI/2; this.scene.add(this._trajMarker);
    }
    const line=this._trajLine, marker=this._trajMarker; line.visible=true; marker.visible=true;
    const fx=Math.sin(rotY), fz=Math.cos(rotY);
    let px=x+fx*0.6, py=y+1.1, pz=z+fz*0.6;
    let vx=fx*CFG.throwSpeed, vy=CFG.throwUpSpeed-pitch*CFG.throwPitchInfluence, vz=fz*CFG.throwSpeed;
    // Simulated at the SAME fixed step the server actually integrates at (1/60 — see
    // NET.FIXED_DT), not a coarser one — this is Euler integration, so a bigger step
    // accumulates more error per step and lands somewhere visibly different than the
    // real projectile over a few tenths of a second of flight. recordEvery only
    // thins out how many of those steps become a LINE VERTEX (keeping MAX_PTS
    // reasonable) — the underlying physics itself always matches the server exactly.
    const dt=1/60;
    const maxSteps=Math.round(CFG.throwLife/dt);
    const recordEvery=Math.max(1,Math.floor(maxSteps/MAX_PTS));
    const pos=line.geometry.attributes.position.array;
    let n=0;
    for(let step=0;step<=maxSteps;step++){
      if(step%recordEvery===0 && n<MAX_PTS){ pos[n*3]=px; pos[n*3+1]=py; pos[n*3+2]=pz; n++; }
      if(py<=0) break;
      vy+=CFG.gravity*dt; px+=vx*dt; py+=vy*dt; pz+=vz*dt;
    }
    // the actual impact point should always be the line's last vertex, even when it
    // falls between two recordEvery-sampled steps
    if(n<MAX_PTS){ pos[n*3]=px; pos[n*3+1]=py; pos[n*3+2]=pz; n++; }
    line.geometry.setDrawRange(0,n);
    line.geometry.attributes.position.needsUpdate=true;
    line.computeLineDistances();   // required for LineDashedMaterial after geometry changes
    marker.position.set(px,0.02,pz);   // slightly above the floor to avoid z-fighting
  }

  spark(x,z,color,scale){ const m=new THREE.Mesh(new THREE.SphereGeometry(0.4,10,8),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity:0.9,blending:THREE.AdditiveBlending}));
    m.position.set(x,1.1,z); m.scale.setScalar(0.1); this.scene.add(m); this.impacts.push({m,life:0,max:0.22,scale}); }
  shake(m){ this.cam.add(m); }
  _updateImpacts(dt){ for(let i=this.impacts.length-1;i>=0;i--){ const it=this.impacts[i]; it.life+=dt; const k=it.life/it.max;
    it.m.scale.setScalar(0.1+k*it.scale*2); it.m.material.opacity=0.9*(1-k); if(k>=1){ this.scene.remove(it.m); this.impacts.splice(i,1); } } }
  render(dt,mouse,target){ this._updateImpacts(dt); this.cam.update(dt,mouse,target); this.renderer.render(this.scene,this.camera); }
}
