// The Character Studio: an admin-only dev tool. Renders its own preview viewport +
// panel into a root element, and hands back a ready CharacterFactory (plus config)
// via result(), so the game can render the exact character you built — no reload.
// Whatever the admin builds here is saved as the ONE game-wide default character —
// every player (signed in or not) renders using it.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { currentGameConfig, currentMovesBalance, MOVE_BALANCE_KEYS } from '../shared/constants.js';
import { SOUND_SLOTS, SOUND_LABELS, SOUND_GROUPS } from '../shared/audio.js';
import { CharacterFactory, buildSampleRig, buildSampleClips, buildRig } from './character.js';
import { SoundBank } from './sound.js';
import * as sync from './character-sync.js';
import * as gcSync from './game-config-sync.js';
import * as soundSync from './sound-sync.js';

// [group label, [cfgKey, field label, step, min, type]] — one row per shared/
// constants.js's GAME_CONFIG_KEYS. Rendered generically (renderGameConfig()) rather
// than by hand, so adding a new tunable there only means adding a row here, not new
// markup. type defaults to a number input; 'bool' renders an on/off toggle instead
// (only `sandbox` needs this — everything else here is numeric).
const GC_FIELDS=[
  ['Movement',[
    ['gravity','gravity',0.5,null],
    ['jumpSpeed','jump speed',0.1,0],
    ['maxFallSpeed','max fall speed',0.5,0],
    ['walk','walk speed',0.1,0],
    ['run','run speed',0.1,0],
    ['accel','accel rate',0.5,0],
    ['decel','decel rate',0.5,0],
    ['turn','turn rate',0.5,0],
    ['airControl','air control ×',0.05,0],
  ]],
  ['Lobby',[
    ['lobbyCountdown','waiting-room countdown (s)',1,1],
    ['lobbyStartBuffer','starting buffer (s)',0.5,0],
    ['battleCountdown','battle countdown, frozen (s)',0.5,0],
  ]],
  ['Health & Stamina',[
    ['maxHp','max health',5,1],
    ['maxStam','max stamina',5,1],
    ['stamRegen','stam regen /s (0 = none)',0.5,0],
    ['stamRegenDelay','regen delay after spending (s)',0.1,0],
    ['stamRegenBlockMult','regen ×while blocking',0.1,0],
    ['sprintStamDrain','sprint drain /s while moving',0.5,0],
  ]],
  ['Block Stamina',[
    // per-move blocked-hit cost lives in the Combat Balance matrix below (blockStam
    // row) — these four are the pool itself: size, passive drain while held, and regen.
    ['maxBlockStam','max block stamina',5,1],
    ['blockStamDrain','passive drain /s while blocking',0.5,0],
    ['blockStamRegen','regen /s (0 = none)',0.5,0],
    ['blockStamRegenDelay','regen delay after blocking (s)',0.1,0],
  ]],
  ['Input Timing',[
    ['hitstopHit','hitstop: light (s)',0.01,0],
    ['hitstopHeavy','hitstop: heavy (s)',0.01,0],
    ['hitstopBlock','hitstop: block (s)',0.01,0],
    ['lightInputCooldown','light cooldown, per-move (s)',0.01,0],
  ]],
  ['Clash (matching moves collide)',[
    // recovery duration isn't here — it tracks the mapped "clash" clip's real length
    // (see moveDurations() below), same as dodge/dead/hit, not a plain typed number.
    ['clashKbMult','clash knockback ×',0.05,0],
    ['hitstopClash','hitstop: clash (s)',0.01,0],
  ]],
  ['Stun (stamina exhaustion)',[
    // Unlike clash/dodge/dead above, this ONE does have a typed override: stunned is a
    // looping state (see client/character.js), so a duration longer than the mapped
    // clip just repeats it seamlessly — e.g. a "dizzy idle" clip held for however long
    // you want, not capped to its own natural length. 0 = use the mapped clip's real
    // length (or 1.2s if none is mapped).
    ['stunDuration','duration override, 0 = use clip length (s)',0.1,0],
  ]],
  ['Battle Royale / Arena',[
    ['maxPlayers','max players',1,1],
    ['spawnRadius','spawn radius',0.5,0],
    ['sandbox','sandbox mode (no bots)',null,null,'bool'],
    ['zoneR0','arena radius',1,0],
    ['fighterRadius','fighter radius',0.05,0.1],
  ]],
  ['Items (Q aim / E throw)',[
    ['itemCount','item count',1,0],
    ['itemPickupRadius','pickup radius',0.1,0.1],
    ['itemRespawn','respawn (s)',1,1],
    ['aimSpeedMult','aim speed ×',0.05,0.05],
    ['throwDur','throw lock (s)',0.05,0.05],
    ['throwSpeed','throw speed',0.5,0.5],
    ['throwUpSpeed','throw arc',0.5,0],
    ['throwLife','throw lifetime (s)',0.1,0.2],
    ['throwDmg','throw damage',1,0],
    ['throwKb','throw knockback',0.5,0],
    ['throwHitRadius','throw hit radius',0.05,0.1],
    ['throwPitchInfluence','throw arc ×camera pitch (look up/down)',0.5,0],
  ]],
  ['Superstar Mode (R)',[
    ['superstarMax','meter max',5,10],
    ['superstarPerDmgDealt','meter / dmg dealt',0.05,0],
    ['superstarPerDmgTaken','meter / dmg taken',0.05,0],
    ['orbCount','orb count',1,0],
    ['orbPickupRadius','orb pickup radius',0.1,0.1],
    ['orbRespawn','orb respawn (s)',1,1],
    ['orbGain','orb meter gain',1,1],
    ['superstarDuration','duration (s)',0.5,1],
    ['superstarDmgMult','damage ×',0.05,1],
    ['superstarSpeedMult','speed ×',0.05,1],
    ['superstarHeavyMult','heavy damage ×',0.05,1],
  ]],
];

// Combat balance: one row per MOVE_BALANCE_KEYS entry, one column per move (reuses
// MOVE_STATES below — same four moves). Excludes `dur`/`range`/`hit` — those already
// have a correct, separate override mechanism (the clip-length/model-size/hit-clip
// sync below); see shared/constants.js's comment on applyMovesBalance() for why a
// second override path for those would conflict.
const MOVE_FIELD_LABELS={ a0:'active start (a0)', a1:'active end (a1)', arc:'front arc (dot)',
  dmg:'damage', kb:'knockback', stam:'stamina cost', blockStam:'block-stam cost (if blocked)', lunge:'lunge speed', speedMult:'playback speed ×' };
const MOVE_FIELD_STEP={ a0:0.01, a1:0.01, arc:0.01, dmg:0.5, kb:0.5, stam:0.5, blockStam:0.5, lunge:0.5, speedMult:0.05 };

const GROUPS=[['Locomotion',['idle','walk','run','jump','fall','carry']],['Combat',['light1','light2','light3','heavy','grab','superAttack']],['Reactions',['block','throw','dodge','hit','grabbed','clash','stunned','dead']]];
const STATES=GROUPS.flatMap(g=>g[1]);
// states with a fixed authoritative "the move takes this long" timer — synced to
// whatever clip is mapped to them, so the animation and the game logic agree. `grab`
// is a real MOVES entry (like heavy) so it belongs here — so is `superAttack` (the
// superstar-mode finisher, see shared/constants.js). `throw` isn't — its duration
// is a fixed CFG value (see shared/constants.js's throwDur), not overridable
// per-character like the combat moves are. `hit`/`dead`/`dodge` are handled separately
// in moveDurations() below (different sync mechanism — see applyHitReactionDuration()/
// applyDeadDuration()/applyDodgeDuration() in shared/constants.js).
const MOVE_STATES=['light1','light2','light3','heavy','grab','superAttack'];
const SYN={idle:['idle','breath'],walk:['walk'],run:['run','jog','sprint'],jump:['jump'],fall:['fall','falling'],
  carry:['carry','carrying','hold','holditem','twohandcarry'],
  light1:['jab','punch','light','attack','cross'],light2:['hook','punch2','combo'],light3:['uppercut','finisher','combo3'],
  heavy:['heavy','haymaker','power','strong'],grab:['grab','suplex','clothesline','vicious','grapple'],
  superAttack:['superattack','ultimate','execute','starslam'],
  block:['block','guard','defend'],
  throw:['throw','pitch','toss','pass'],dodge:['dodge','roll','evade','dash'],
  hit:['hit','impact','react','hurt','damage'],
  grabbed:['grabbed','thrown','suplexed','tossed','flying'],
  clash:['clash','parry','deflect','bounce','collide'],
  stunned:['stunned','stun','dazed','dizzy','exhausted','winded'],
  dead:['dead','death','ko','die','defeat']};

// Rotary knob: drag vertically to adjust a value (standard "virtual knob" UX —
// dragging in an actual circle around a small on-screen target is fiddly/imprecise
// with a mouse, so up/down drag distance maps to the value change instead). Used for
// the Audio Mixer's per-sample trim start/end points below, in place of yet another
// pair of sliders, per the specific ask for knobs there. `el` just needs the
// `st-knob` CSS class (index.html) — this only wires behavior, not markup.
function makeKnob(el, { min=0, max=1, value=0, sensitivity=160, onChange, onCommit }={}){
  let v = Math.min(max, Math.max(min, value));
  const paint=()=>{ const t = max>min ? (v-min)/(max-min) : 0; el.style.setProperty('--ang', (-135+t*270)+'deg'); };
  const k = {
    set(nv){ v=Math.min(max,Math.max(min,nv)); paint(); },
    setRange(mn,mx){ min=mn; max=mx; v=Math.min(max,Math.max(min,v)); paint(); },
    get(){ return v; },
  };
  el.addEventListener('pointerdown', e=>{
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const startY=e.clientY, startV=v, range=(max-min)||1;
    const move=ev=>{ const dy=startY-ev.clientY; k.set(startV+(dy/sensitivity)*range); onChange && onChange(v); };
    const up=ev=>{ move(ev); onCommit && onCommit(v);
      el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); };
    el.addEventListener('pointermove',move); el.addEventListener('pointerup',up);
  });
  paint();
  return k;
}

const HTML=`
<div class="st-view"><div class="st-empty"><div><div class="st-ic">⊕</div><h2>Load a rig to begin</h2>
  <p>Drop a <b>.glb</b>, <b>.gltf</b> or <b>.fbx</b> here. Mixamo files work directly.<br>Or press <b>Load sample</b> to explore with a built-in rig.</p></div></div>
  <div class="st-playbar"><button class="st-ic-btn" data-play>❚❚</button><div class="st-cur" data-cur>—</div><button class="st-ic-btn on" data-loop>↻</button><input type="range" data-speed min="0" max="2" step="0.05" value="1"></div></div>
<div class="st-panel">
  <div class="st-head"><div class="t">Slam Royale</div><div class="n">Character Studio</div><button id="studioBackBtn">← menu</button></div>
  <div class="st-body">
    <div class="st-sec"><div class="h">Model <span class="st-tg" data-rot>turntable</span></div>
      <div class="st-drop" data-mdrop><b>Drop model</b> or click — .glb / .gltf / .fbx</div>
      <div class="st-pill" data-mname style="display:none"></div>
      <div class="st-rmbtn" data-rmmodel style="display:none">✕ remove model</div>
      <div class="st-ctl"><label>scale</label><input type="range" data-scale min="0.001" max="2" step="0.001" value="1"><span class="v" data-scalev>1.00</span></div>
      <div class="st-ctl"><label>yaw offset</label><input type="range" data-yaw min="-3.1416" max="3.1416" step="0.0175" value="0"><span class="v" data-yawv>0°</span></div>
      <div class="st-ctl"><label>team tint</label><input type="color" data-tint value="#3b82f6"><span class="st-tg" data-tintbtn>off</span></div>
      <div class="st-ctl"><label>strip root motion</label><span class="st-tg on" data-strip>on</span></div></div>
    <div class="st-sec"><div class="h">Animations</div>
      <div class="st-drop" data-adrop><b>Drop animation clips</b> — one .fbx/.glb per move</div>
      <div class="st-pill" data-alist style="display:none"></div></div>
    <div class="st-sec"><div class="h">State → Clip mapping</div><div data-states></div></div>
    <div class="st-sec"><div class="h">Match Balance</div><div data-gc></div></div>
    <div class="st-sec"><div class="h">Combat Balance</div><div data-moves></div></div>
    <div class="st-sec"><div class="h">Audio Mixer</div><div data-audio></div></div>
  </div>
  <div class="st-foot"><div class="st-status" data-status></div>
    <textarea class="st-json" data-json readonly spellcheck="false"></textarea>
    <div class="st-row2"><button class="st-btn" data-sample>Load sample</button><button class="st-btn" data-copy>Copy JSON</button></div>
    <button class="st-btn pri" data-enter>Enter match →</button>
    <div class="st-clearlink" data-clear>clear saved character</div></div>
</div>
<input type="file" data-mfile accept=".glb,.gltf,.fbx" style="display:none">
<input type="file" data-afile accept=".glb,.gltf,.fbx" multiple style="display:none">
<input type="file" data-sfile accept="audio/*" style="display:none">`;

export class Studio{
  constructor(root, onEnter){
    this.root=root; this.onEnter=onEnter; root.innerHTML=HTML; root.classList.add('studio-root');
    this.S={ model:null, wrapper:null, mixer:null, embedded:[], external:new Map(), assign:{},
      scale:1, yaw:0, tint:null, strip:true, modelName:null, boneNames:new Set(),
      current:null, action:null, paused:false, speed:1, loop:true, autorot:false,
      isSample:false, modelFile:null };
    this.GC=currentGameConfig(); this.MV=currentMovesBalance();   // seeded with hardcoded defaults; _loadGameConfig() below overwrites with whatever's persisted
    this.audio=new SoundBank(); this.audioCfg=Object.fromEntries(SOUND_SLOTS.map(s=>[s,{volume:1,hasSample:false,name:null,start:0,end:null}]));
    this._knobs={};   // slot -> {start,end} knob instances, see renderAudioMixer()
    this._authed=false; this._restoring=false;
    this._viewport(); this._wire(); this.refreshStates(); this.refreshJSON();
    this.renderGameConfig(); this.renderMoveBalance(); this.renderAudioMixer();
    this.status('Drop a rig, or press “Load sample”. Then Enter match.');
    this.running=true; this._loop();
  }
  // called by main.js right after mount, and again whenever admin sign-in state changes
  onAuthChange(isAdmin){
    this._authed=isAdmin;
    if(isAdmin){ this._restoreFromServer(); this._loadGameConfig(); this._loadAudioConfig(); }
    else this.status('Sign in as the admin account to edit the game’s default character.');
  }
  q(s){ return this.root.querySelector(s); }
  _viewport(){
    const host=this.q('.st-view');
    this.renderer=new THREE.WebGLRenderer({antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.renderer.shadowMap.enabled=true; this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure=1.05; this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    host.insertBefore(this.renderer.domElement, host.firstChild);
    this.scene=new THREE.Scene(); this.camera=new THREE.PerspectiveCamera(50,1,0.01,500); this.camera.position.set(2.4,1.8,3.6);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement); this.controls.enableDamping=true; this.controls.target.set(0,1,0);
    const sky=new THREE.Mesh(new THREE.SphereGeometry(200,32,16),new THREE.ShaderMaterial({side:THREE.BackSide,
      uniforms:{top:{value:new THREE.Color(0x20242e)},bot:{value:new THREE.Color(0x0b0d10)}},
      vertexShader:`varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`varying vec3 p;uniform vec3 top;uniform vec3 bot;void main(){float h=normalize(p).y*.5+.5;gl_FragColor=vec4(mix(bot,top,pow(h,.8)),1.);}`}));
    this.scene.add(sky);
    const disc=new THREE.Mesh(new THREE.CircleGeometry(6,64),new THREE.MeshStandardMaterial({color:0x30343d,roughness:0.9})); disc.rotation.x=-Math.PI/2; disc.receiveShadow=true; this.scene.add(disc);
    const grid=new THREE.PolarGridHelper(6,8,6,64,0x3a3f49,0x2a2e37); grid.position.y=0.002; this.scene.add(grid);
    this.scene.add(new THREE.HemisphereLight(0xc3d1ef,0x2a2620,0.85));
    const key=new THREE.DirectionalLight(0xfff1dc,2.6); key.position.set(4,7,4); key.castShadow=true; key.shadow.mapSize.set(2048,2048);
    const c=key.shadow.camera; c.left=-6;c.right=6;c.top=6;c.bottom=-6;c.near=.5;c.far=25; key.shadow.bias=-0.0004; this.scene.add(key);
    const rim=new THREE.DirectionalLight(0x88aaff,1.0); rim.position.set(-5,3,-4); this.scene.add(rim);
    this.clock=new THREE.Clock(); this._resize=()=>this.resize(); addEventListener('resize',this._resize); this.resize();
  }
  resize(){ const host=this.q('.st-view'); const w=host.clientWidth||1, h=host.clientHeight||1; this.renderer.setSize(w,h); this.camera.aspect=w/h; this.camera.updateProjectionMatrix(); }
  _loop(){ if(!this.running) return; requestAnimationFrame(()=>this._loop());
    const dt=this.clock.getDelta();
    if(this.S.mixer && !this.S.paused) this.S.mixer.update(dt*this.S.speed);
    if(this.S.autorot && this.S.wrapper) this.S.wrapper.rotation.y+=dt*0.5;
    this.controls.update(); this.renderer.render(this.scene,this.camera);
  }
  start(){ if(!this.running){ this.running=true; this.clock.getDelta(); this.resize(); this._loop(); } }
  stop(){ this.running=false; }

  async loadFile(file){ return await this.loadUrl(URL.createObjectURL(file), file.name); }
  async loadUrl(url,name){ const ext=name.split('?')[0].split('.').pop().toLowerCase();
    if(ext==='glb'||ext==='gltf'){ const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js'); const g=await new GLTFLoader().loadAsync(url); return {scene:g.scene,animations:g.animations||[]}; }
    if(ext==='fbx'){ const {FBXLoader}=await import('three/addons/loaders/FBXLoader.js'); const f=await quietly(()=>new FBXLoader().loadAsync(url)); return {scene:f,animations:f.animations||[]}; }
    throw new Error('Unsupported: .'+ext); }

  // Above this, an instance renders once (here, in preview); in the actual match, every
  // one of up to 8 fighters on screen at once is a full-detail clone of the same mesh —
  // there's no distance/LOD reduction — so a heavy model here means an 8x heavier match.
  TRI_WARN_THRESHOLD=20000;
  setModel(root,clips,name){
    if(this.S.wrapper) this.scene.remove(this.S.wrapper);
    this.S.wrapper=new THREE.Group();
    let tris=0;
    root.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; o.frustumCulled=false; if(o.material)o.userData._m=o.material;
      const g=o.geometry; if(g) tris += (g.index ? g.index.count : g.attributes.position.count)/3; } });
    this.S.triCount=Math.round(tris);
    this.S.wrapper.add(root); this.scene.add(this.S.wrapper);
    this.S.model=root; this.S.modelName=name; this.S.embedded=clips.slice();
    this.S.boneNames=new Set(); root.traverse(o=>{ if(o.name)this.S.boneNames.add(o.name); });
    this.S.mixer=new THREE.AnimationMixer(root); this.S.action=null; this.S.current=null;
    this._autoScaleToRig();
    this.applyScale(); this.applyYaw(); this.applyTint(); this.frame(); this.autoAssign();
    this.q('.st-empty').classList.add('gone'); const mn=this.q('[data-mname]'); mn.style.display='block'; mn.textContent=name;
    this.q('[data-rmmodel]').style.display='block';
    this.refreshStates(); this.refreshJSON();
    if(this.S.assign.idle) this.preview('idle'); else { const s=STATES.find(s=>this.S.assign[s]); if(s)this.preview(s); }
    const tk=this.S.triCount.toLocaleString();
    if(this.S.triCount>this.TRI_WARN_THRESHOLD)
      this.status(`Loaded ${name} · ${clips.length} clip${clips.length!==1?'s':''} · ⚠ ${tk} tris — heavy for a fighter shown up to 8× at once with no LOD; consider decimating before shipping this as the default`,'warn');
    else this.status(`Loaded ${name} · ${clips.length} clip${clips.length!==1?'s':''} · ${tk} tris`,'ok');
  }
  applyScale(){ if(this.S.model){ this.S.model.scale.setScalar(this.S.scale); this.frame(); } }
  applyYaw(){ if(this.S.wrapper) this.S.wrapper.rotation.y=this.S.yaw; }
  applyTint(){ if(!this.S.model)return; this.S.model.traverse(o=>{ if(!o.isMesh||!o.userData._m)return;
    const base=o.userData._m, mats=Array.isArray(base)?base:[base];
    const out=mats.map(m=>{ const n=m.clone(); if(this.S.tint&&n.emissive){n.emissive.set(this.S.tint);n.emissiveIntensity=0.35;} else if(n.emissive){n.emissiveIntensity=0;} return n; });
    o.material=Array.isArray(base)?out:out[0]; }); }
  frame(){ if(!this.S.wrapper)return; const box=new THREE.Box3().setFromObject(this.S.wrapper); if(box.isEmpty())return;
    const size=box.getSize(new THREE.Vector3()), center=box.getCenter(new THREE.Vector3()); const h=Math.max(size.y,0.5);
    this.controls.target.copy(center); const d=h*2.2; this.camera.position.copy(center).add(new THREE.Vector3(d*0.6,h*0.15,d)); this.controls.update(); }

  strip(clip){ if(!clip.userData)clip.userData={}; if(!clip.userData.orig)clip.userData.orig=clip.tracks.slice();
    clip.tracks=this.S.strip?clip.userData.orig.filter(t=>!/(Hips|hips|root|Root)\.position$/.test(t.name)):clip.userData.orig.slice(); }
  // A real animation-only export is just keyframe curves — a few hundred KB at
  // most, even for a long clip. Anywhere near this threshold almost always means the
  // export accidentally embedded the full mesh/skin/texture data alongside the
  // animation (Mixamo's default "with skin" download, meant for the very first
  // character export, easy to leave on by mistake for every animation after that) —
  // the clip still works fine since only the curve is ever actually used, but the
  // file itself gets downloaded and parsed by EVERY player joining EVERY match, all
  // for data that's immediately thrown away. Multiplied across several such clips
  // this turns into a genuinely slow, wasteful load for everyone.
  ANIM_SIZE_WARN_BYTES=5*1024*1024;
  async addAnim(file){ try{ const a=await this.loadFile(file); const clip=a.animations[0];
    if(!clip){ this.status(`No clip in ${file.name}`,'err'); return; }
    clip.name=file.name.replace(/\.[^.]+$/,''); this.strip(clip);
    this.S.external.set(file.name,{clip,file}); this.autoAssign(); this.refreshAnimList(); this.refreshStates(); this.refreshJSON();
    if(file.size>this.ANIM_SIZE_WARN_BYTES){
      const mb=(file.size/1024/1024).toFixed(1);
      this.status(`Added ${file.name} · ⚠ ${mb} MB — likely exported "with skin," embedding the full mesh again; re-export animation-only ("without skin") from Mixamo to shrink this to well under 1 MB`,'warn');
    } else this.status(`Added ${file.name}`,'ok');
    if(this._authed&&!this._restoring){ try{ await sync.uploadAnim(file,this._settingsSnapshot()); }catch(e){ this.status('Saved locally, but sync failed: '+e.message,'err'); } }
    }catch(e){ this.status('Error: '+e.message,'err'); } }
  reStrip(){ for(const {clip} of this.S.external.values()) this.strip(clip); if(this.S.current)this.preview(this.S.current); }

  clipFor(st){ const a=this.S.assign[st]; if(!a)return null;
    if(a.source==='embedded')return this.S.embedded.find(c=>c.name===a.name)||null;
    const e=this.S.external.get(a.name); return e?e.clip:null; }
  // real clip length per move, so the game's authoritative move timing can match the
  // animation instead of the built-in procedural rig's hand-tuned defaults. `hit`,
  // `dead`, `dodge`, `clash`, and `grabbed` piggyback on this same payload
  // (shared/constants.js's applyMoveDurations() reads overrides.hit/dead/dodge/clash/
  // grabbed too) even though they're not in MOVE_STATES — `hit` scales every move's
  // hitstun proportionally (only one hit-reaction clip slot exists, so it can't
  // override each move independently like dur/range do), `dead`/`dodge`/`clash` are
  // single global held-pose/roll/stagger durations, and `grabbed` is grab's own
  // target-reaction hold — tracked separately from `hit` specifically so a distinctly-
  // mapped "being thrown" clip doesn't drift out of sync against grab's own swing
  // (previously it silently reused `hit`'s scaled duration instead). `block` has no
  // duration sync at all — it releases the instant the button does, cutting the clip
  // short if it's longer, and holds on the last frame if you hold longer.
  moveDurations(){ const out={}; for(const st of MOVE_STATES){ const c=this.clipFor(st); if(c&&c.duration>0) out[st]=round(c.duration); }
    const hitClip=this.clipFor('hit'); if(hitClip&&hitClip.duration>0) out.hit=round(hitClip.duration);
    const deadClip=this.clipFor('dead'); if(deadClip&&deadClip.duration>0) out.dead=round(deadClip.duration);
    const dodgeClip=this.clipFor('dodge'); if(dodgeClip&&dodgeClip.duration>0) out.dodge=round(dodgeClip.duration);
    const clashClip=this.clipFor('clash'); if(clashClip&&clashClip.duration>0) out.clash=round(clashClip.duration);
    const stunClip=this.clipFor('stunned'); if(stunClip&&stunClip.duration>0) out.stun=round(stunClip.duration);
    const grabbedClip=this.clipFor('grabbed'); if(grabbedClip&&grabbedClip.duration>0) out.grabbed=round(grabbedClip.duration);
    return out; }
  // actual on-screen size relative to a normal human — NOT the same as this.S.scale,
  // which is often just a unit-conversion fudge factor (e.g. Mixamo rigs are authored
  // in centimeters, so scale ends up ~0.01 even though the character renders life-sized).
  // Combat reach should track how big the character actually looks, so measure its real
  // bounding-box height post-scale instead of trusting the raw scale number.
  sizeRatio(){ if(!this.S.wrapper)return 1; const box=new THREE.Box3().setFromObject(this.S.wrapper); if(box.isEmpty())return 1;
    const h=box.getSize(new THREE.Vector3()).y; if(!(h>0))return 1;
    return round(THREE.MathUtils.clamp(h/1.8,0.2,5)); }
  // The game places bodies with a feet-at-origin convention (ground = y 0, model
  // extends upward). Many rigs — Mixamo included — put their own local origin at the
  // hips instead, so without correction the feet render below floor level. Measure how
  // far the model's lowest point sits from its own origin and shift it up to match.
  groundOffset(){ if(!this.S.wrapper)return 0; const box=new THREE.Box3().setFromObject(this.S.wrapper); if(box.isEmpty())return 0;
    return round(THREE.MathUtils.clamp(-box.min.y,-3,3)); }
  // The built-in rig's real rendered height, measured the same way (Box3 on a live
  // instance) rather than hand-typed — so this stays correct even if buildRig()'s
  // proportions ever change later. Cached: the geometry is static, no need to rebuild
  // a throwaway rig on every import.
  _defaultRigHeight(){ if(this.__rigH==null){ const rig=buildRig(0xffffff); rig.updateMatrixWorld(true);
      const box=new THREE.Box3().setFromObject(rig); this.__rigH=box.isEmpty()?1.8:box.getSize(new THREE.Vector3()).y; }
    return this.__rigH; }
  // New imports land at whatever scale their file happened to be authored at (Mixamo's
  // cm-to-m export is ~0.01, some tools export literal meters, some are just wrong) with
  // no way to guess the right number in advance. Default the scale so the model's real
  // measured height matches the procedural rig's real measured height exactly, using
  // the same Box3 pattern as sizeRatio()/groundOffset(). Still just a starting point —
  // the scale slider remains fully manual afterward if the admin wants to override it.
  _autoScaleToRig(){ if(!this.S.model||!this.S.wrapper) return;
    this.S.model.scale.setScalar(1); this.S.wrapper.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(this.S.wrapper); if(box.isEmpty()) return;
    const h=box.getSize(new THREE.Vector3()).y; if(!(h>0)) return;
    this.S.scale=round(THREE.MathUtils.clamp(this._defaultRigHeight()/h,0.001,2));
    this.q('[data-scale]').value=this.S.scale; this.q('[data-scalev]').textContent=this.S.scale.toFixed(2); }
  compat(st){ const c=this.clipFor(st); if(!c||!this.S.boneNames.size)return true;
    for(const t of c.tracks){ const b=t.name.slice(0,t.name.lastIndexOf('.')); if(this.S.boneNames.has(b))return true; } return false; }
  preview(st){ if(!this.S.mixer)return; const clip=this.clipFor(st); this.S.current=st; this.q('[data-cur]').textContent=st; this.markActive();
    if(!clip){ if(this.S.action){this.S.action.fadeOut(0.2);this.S.action=null;} return; }
    const nx=this.S.mixer.clipAction(clip); nx.reset(); nx.setLoop(this.S.loop?THREE.LoopRepeat:THREE.LoopOnce,Infinity); nx.clampWhenFinished=true; nx.fadeIn(0.22).play();
    if(this.S.action&&this.S.action!==nx)this.S.action.fadeOut(0.22); this.S.action=nx; this.S.paused=false; this.q('[data-play]').textContent='❚❚'; }
  autoAssign(){ for(const st of STATES){ if(this.S.assign[st])continue; const keys=SYN[st]||[st];
    let hit=this.S.embedded.find(c=>keys.some(k=>c.name.toLowerCase().includes(k)));
    if(hit){ this.S.assign[st]={source:'embedded',name:hit.name}; continue; }
    for(const [f] of this.S.external){ if(keys.some(k=>f.toLowerCase().includes(k))){ this.S.assign[st]={source:'external',name:f}; break; } } } }

  options(st){ const a=this.S.assign[st]; let h=`<option value="">— none —</option>`;
    if(this.S.embedded.length){ h+=`<optgroup label="embedded">`; for(const c of this.S.embedded){ const v='embedded:'+c.name; h+=`<option value="${v}" ${a&&a.source==='embedded'&&a.name===c.name?'selected':''}>${esc(c.name)}</option>`; } h+=`</optgroup>`; }
    if(this.S.external.size){ h+=`<optgroup label="files">`; for(const [f] of this.S.external){ const v='external:'+f; h+=`<option value="${v}" ${a&&a.source==='external'&&a.name===f?'selected':''}>${esc(f)}</option>`; } h+=`</optgroup>`; }
    return h; }
  refreshStates(){ let h=''; for(const [label,list] of GROUPS){ h+=`<div class="st-grp">${label}</div>`;
    for(const st of list){ const a=this.S.assign[st]; h+=`<div class="st-mrow ${this.S.current===st?'active':''}" data-st="${st}">
      <div class="mst">${st}</div><select class="${a?'':'unset'} ${(a&&!this.compat(st))?'bad':''}" data-st="${st}">${this.options(st)}</select>
      <div class="mpv" data-st="${st}">▶</div></div>`; } }
    const el=this.q('[data-states]'); el.innerHTML=h;
    el.querySelectorAll('select').forEach(s=>s.addEventListener('change',e=>{ const st=e.target.dataset.st,v=e.target.value;
      if(!v)delete this.S.assign[st]; else{ const [source,...r]=v.split(':'); this.S.assign[st]={source,name:r.join(':')}; }
      this.refreshStates(); this.refreshJSON(); if(this.S.current===st)this.preview(st); this._schedulePersist(); }));
    el.querySelectorAll('.mpv').forEach(b=>b.addEventListener('click',()=>this.preview(b.dataset.st))); this.markActive(); }
  markActive(){ this.root.querySelectorAll('.st-mrow').forEach(r=>r.classList.toggle('active',r.dataset.st===this.S.current)); }
  refreshAnimList(){ const el=this.q('[data-alist]'); if(!this.S.external.size){el.style.display='none';return;} el.style.display='block'; el.textContent=[...this.S.external.keys()].join(' · '); }

  // Match Balance: built once from GC_FIELDS (not hand-written markup), one input per
  // shared/constants.js tunable — a number input, except `sandbox` (an on/off toggle,
  // the only boolean in the set). Edits go straight into this.GC and persist via the
  // same debounce pattern as the rest of the Studio's settings.
  renderGameConfig(){
    let h=''; for(const [label,fields] of GC_FIELDS){ h+=`<div class="st-grp">${label}</div>`;
      for(const [key,lbl,step,min,type] of fields){
        if(type==='bool') h+=`<div class="st-ctl"><label>${lbl}</label><span class="st-tg" data-gcbool="${key}">off</span></div>`;
        else h+=`<div class="st-ctl"><label>${lbl}</label><input type="number" step="${step}" ${min!=null?`min="${min}"`:''} data-gc="${key}"></div>`;
      } }
    this.q('[data-gc]').innerHTML=h;
    this.q('[data-gc]').querySelectorAll('input[data-gc]').forEach(inp=>{
      inp.addEventListener('input',e=>{ this.GC[e.target.dataset.gc]=+e.target.value; this._scheduleGamePersist(); }); });
    this.q('[data-gc]').querySelectorAll('[data-gcbool]').forEach(btn=>{
      btn.addEventListener('click',e=>{ const k=e.target.dataset.gcbool, on=e.target.classList.toggle('on');
        e.target.textContent=on?'on':'off'; this.GC[k]=on; this._scheduleGamePersist(); }); });
    this.refreshGameConfigInputs();
  }
  refreshGameConfigInputs(){ for(const [,fields] of GC_FIELDS) for(const [key,,,,type] of fields){
    if(type==='bool'){ const btn=this.q(`[data-gcbool="${key}"]`); if(btn){ const on=!!this.GC[key]; btn.classList.toggle('on',on); btn.textContent=on?'on':'off'; } }
    else { const inp=this.q(`input[data-gc="${key}"]`); if(inp) inp.value=round(this.GC[key]); } } }

  // Combat Balance: a compact grid — one row per MOVE_BALANCE_KEYS entry, one column
  // per move (MOVE_STATES) — rather than GC_FIELDS' stacked rows, since 4 moves × 8
  // fields as separate .st-ctl rows would be 32 rows of vertical scrolling.
  renderMoveBalance(){
    let h=`<div class="st-mtrow st-mthead"><div></div>${MOVE_STATES.map(n=>`<div>${n}</div>`).join('')}</div>`;
    for(const key of MOVE_BALANCE_KEYS){
      h+=`<div class="st-mtrow"><div class="st-mtlbl">${MOVE_FIELD_LABELS[key]}</div>${MOVE_STATES.map(n=>
        `<input type="number" step="${MOVE_FIELD_STEP[key]}" data-mv="${n}.${key}">`).join('')}</div>`;
    }
    this.q('[data-moves]').innerHTML=h;
    this.q('[data-moves]').querySelectorAll('input[data-mv]').forEach(inp=>{
      inp.addEventListener('input',e=>{ const [name,key]=e.target.dataset.mv.split('.');
        if(!this.MV[name]) this.MV[name]={}; this.MV[name][key]=+e.target.value; this._scheduleGamePersist(); }); });
    this.refreshMoveBalanceInputs();
  }
  refreshMoveBalanceInputs(){ for(const name of MOVE_STATES) for(const key of MOVE_BALANCE_KEYS){
    const inp=this.q(`input[data-mv="${name}.${key}"]`); if(inp && this.MV[name]) inp.value=round(this.MV[name][key]); } }

  // Both Match Balance and Combat Balance ride the same fetch/persist round-trip — the
  // server's PATCH /api/game-config takes and returns one combined payload (see
  // server/api.js), so there's one debounce timer and one save path for both panels.
  async _loadGameConfig(){
    try{ const {moves,...flat}=await gcSync.getGameConfig(); this.GC=flat; this.MV=moves||{};
      this.refreshGameConfigInputs(); this.refreshMoveBalanceInputs(); }
    catch(e){ console.warn('studio: could not load match balance config',e); } }
  _scheduleGamePersist(){ if(!this._authed) return; clearTimeout(this._gcpt); this._gcpt=setTimeout(()=>this._persistGameConfig(),400); }
  async _persistGameConfig(){
    try{ const {moves,...flat}=await gcSync.patchGameConfig({...this.GC,moves:this.MV}); this.GC=flat; this.MV=moves||{};
      this.refreshGameConfigInputs(); this.refreshMoveBalanceInputs(); }
    catch(e){ console.warn('studio: could not save match balance config',e); this.status('Could not save match balance: '+e.message,'err'); } }

  // Audio Mixer: one volume slider + one sample slot per shared/audio.js's SOUND_SLOTS
  // (grouped into SOUND_GROUPS — 20 slots flat would be a wall of identical rows).
  // Sample playback/decoding goes through the same SoundBank used in-match, so
  // "preview" here sounds exactly like it will in a real game. See client/net.js
  // (your own predicted actions), client/main.js (server-broadcast combat events +
  // match end/pickups), server/world.js (pickup events) for where each actually fires.
  renderAudioMixer(){
    let h=''; for(const [groupLabel,slots] of SOUND_GROUPS){
      h+=`<div class="st-grp">${groupLabel}</div>`;
      for(const slot of slots){
        h+=`<div class="st-ctl"><label>${SOUND_LABELS[slot]||slot} — volume</label><input type="range" min="0" max="1" step="0.01" data-vol="${slot}"><span class="v" data-volv="${slot}">100%</span></div>
          <div class="st-ctl"><label>sample</label><div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;flex:1">
            <span class="st-pill" data-samplename="${slot}" style="margin:0">— none —</span>
            <span class="st-tg" data-choose="${slot}">choose file</span>
            <span class="st-tg" data-preview="${slot}" style="display:none">▶</span>
          </div></div>
          <div class="st-rmbtn" data-clearsample="${slot}" style="display:none">✕ remove sample</div>
          <div class="st-ctl" data-trimrow="${slot}" style="display:none">
            <label>trim</label>
            <div style="display:flex;gap:16px;align-items:center;justify-content:flex-end;flex:1">
              <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
                <div class="st-knob" data-knob-start="${slot}"></div>
                <span class="v" data-startv="${slot}" style="font-size:9px">start 0.00s</span>
              </div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:3px">
                <div class="st-knob" data-knob-end="${slot}"></div>
                <span class="v" data-endv="${slot}" style="font-size:9px">end 0.00s</span>
              </div>
            </div>
          </div>`;
      }
    }
    this.q('[data-audio]').innerHTML=h;
    this.q('[data-audio]').querySelectorAll('input[data-vol]').forEach(inp=>{
      inp.addEventListener('input',e=>{ const slot=e.target.dataset.vol, v=+e.target.value;
        if(!this.audioCfg[slot]) this.audioCfg[slot]={volume:1,hasSample:false,name:null,start:0,end:null};
        this.audioCfg[slot].volume=v; this.audio.setVolume(slot,v);
        const volv=this.q(`[data-volv="${slot}"]`); if(volv) volv.textContent=Math.round(v*100)+'%';
        this._scheduleAudioPersist(); }); });
    this.q('[data-audio]').querySelectorAll('[data-choose]').forEach(el=>{
      el.addEventListener('click',()=>{ this._pendingAudioSlot=el.dataset.choose; this.q('[data-sfile]').click(); }); });
    this.q('[data-audio]').querySelectorAll('[data-preview]').forEach(el=>{
      el.addEventListener('click',()=>{ this.audio.resume(); this.audio.play(el.dataset.preview); }); });
    this.q('[data-audio]').querySelectorAll('[data-clearsample]').forEach(el=>{
      el.addEventListener('click',async()=>{ const slot=el.dataset.clearsample;
        if(this._authed){ try{ await soundSync.deleteSoundSample(slot); }catch(e){ this.status('Could not remove sample: '+e.message,'err'); return; } }
        this.audioCfg[slot]={...(this.audioCfg[slot]||{volume:1}),hasSample:false,name:null,start:0,end:null}; this.audio.buffers[slot]=null;
        this.audio.setTrim(slot,0,null);
        this.refreshAudioMixerInputs(); }); });
    // Trim knobs: one pair (start/end) per slot, wired once here — refreshAudioMixerInputs()
    // below only ever adjusts their range/value afterward, never recreates them, so a
    // drag in progress can't get its listeners torn out from under it by an unrelated
    // refresh (e.g. another field's autosave completing).
    for(const slot of SOUND_SLOTS){
      const startEl=this.q(`[data-knob-start="${slot}"]`), endEl=this.q(`[data-knob-end="${slot}"]`);
      if(!startEl||!endEl) continue;
      const commit=()=>{ this._scheduleAudioPersist(); };
      const applyLive=()=>{ const entry=this.audioCfg[slot]; this.audio.setTrim(slot,entry.start,entry.end);
        const sv=this.q(`[data-startv="${slot}"]`); if(sv) sv.textContent=`start ${entry.start.toFixed(2)}s`;
        const ev=this.q(`[data-endv="${slot}"]`); if(ev) ev.textContent=`end ${(entry.end??this._sampleDur(slot)).toFixed(2)}s`; };
      const kStart=makeKnob(startEl,{min:0,max:1,value:0,
        onChange:v=>{ this.audioCfg[slot].start=round(v); applyLive(); }, onCommit:commit});
      const kEnd=makeKnob(endEl,{min:0,max:1,value:1,
        onChange:v=>{ this.audioCfg[slot].end=round(v); applyLive(); }, onCommit:commit});
      this._knobs[slot]={start:kStart,end:kEnd};
    }
    this.refreshAudioMixerInputs();
  }
  // The knob's own max needs the sample's real length, only known once it's decoded
  // (this.audio.buffers[slot]) — 1 is just a placeholder before any sample exists,
  // the trim row itself stays hidden until hasSample anyway so it's never seen.
  _sampleDur(slot){ return this.audio.buffers[slot]?.duration || 1; }
  refreshAudioMixerInputs(){ for(const slot of SOUND_SLOTS){
    const entry=this.audioCfg[slot]||{volume:1,hasSample:false,name:null,start:0,end:null};
    const vol=this.q(`input[data-vol="${slot}"]`); if(vol) vol.value=entry.volume;
    const volv=this.q(`[data-volv="${slot}"]`); if(volv) volv.textContent=Math.round(entry.volume*100)+'%';
    const nameEl=this.q(`[data-samplename="${slot}"]`);
    if(nameEl){ nameEl.textContent=entry.hasSample?(entry.name||'sample loaded'):'— none —'; nameEl.style.color=entry.hasSample?'var(--good)':'var(--faint)'; }
    const prevBtn=this.q(`[data-preview="${slot}"]`); if(prevBtn) prevBtn.style.display=entry.hasSample?'inline-block':'none';
    const clearBtn=this.q(`[data-clearsample="${slot}"]`); if(clearBtn) clearBtn.style.display=entry.hasSample?'block':'none';
    const trimRow=this.q(`[data-trimrow="${slot}"]`); if(trimRow) trimRow.style.display=entry.hasSample?'flex':'none';
    if(entry.hasSample && this._knobs[slot]){
      const dur=this._sampleDur(slot);
      const {start,end}=this._knobs[slot];
      start.setRange(0,dur); start.set(Math.min(entry.start||0,dur));
      end.setRange(0,dur); end.set(entry.end!=null?Math.min(entry.end,dur):dur);
      const sv=this.q(`[data-startv="${slot}"]`); if(sv) sv.textContent=`start ${start.get().toFixed(2)}s`;
      const ev=this.q(`[data-endv="${slot}"]`); if(ev) ev.textContent=`end ${end.get().toFixed(2)}s`;
    } } }
  async _handleAudioUpload(file){
    const slot=this._pendingAudioSlot; if(!slot) return;
    try{
      await this.audio.loadFilePreview(slot,file);
      if(this._authed){ const cfg=await soundSync.uploadSoundSample(slot,file); this.audioCfg=cfg; }
      else this.audioCfg[slot]={...(this.audioCfg[slot]||{volume:1}),hasSample:true,name:file.name,start:0,end:null};
      this.refreshAudioMixerInputs();
      this.status(`Loaded "${file.name}" for ${SOUND_LABELS[slot]||slot}`,'ok');
    }catch(e){ this.status('Could not load sample: '+e.message,'err'); }
  }
  async _loadAudioConfig(){
    try{ this.audioCfg=await soundSync.getSoundConfig(); this.refreshAudioMixerInputs(); await this.audio.load(this.audioCfg); this.refreshAudioMixerInputs(); }
    catch(e){ console.warn('studio: could not load sound config',e); } }
  _scheduleAudioPersist(){ if(!this._authed) return; clearTimeout(this._apt); this._apt=setTimeout(()=>this._persistAudioConfig(),400); }
  async _persistAudioConfig(){
    const body={}; for(const slot of SOUND_SLOTS){ const e=this.audioCfg[slot]||{};
      body[slot]={volume:e.volume??1, start:e.start??0, end:e.end??null}; }
    try{ this.audioCfg=await soundSync.patchSoundConfig(body); this.refreshAudioMixerInputs(); }
    catch(e){ console.warn('studio: could not save sound config',e); this.status('Could not save audio mixer: '+e.message,'err'); } }

  buildConfig(){ const clips={},animations={};
    for(const st of STATES){ const a=this.S.assign[st]; if(!a)continue; if(a.source==='embedded')clips[st]=a.name; else animations[st]=a.name; }
    const cfg={ model:this.S.modelName||'your-model.glb', scale:round(this.S.scale), yawOffset:round(this.S.yaw), stripRootMotion:this.S.strip, tint:this.S.tint };
    if(Object.keys(clips).length)cfg.clips=clips; if(Object.keys(animations).length)cfg.animations=animations;
    const durations=this.moveDurations(); if(Object.keys(durations).length)cfg.durations=durations;
    cfg.sizeRatio=this.sizeRatio();
    cfg.groundOffset=this.groundOffset();
    return cfg; }
  refreshJSON(){ this.q('[data-json]').value=JSON.stringify(this.buildConfig(),null,2); }
  status(t,cls=''){ const el=this.q('[data-status]'); el.textContent=t; el.className='st-status '+cls; }

  // hand a ready-to-instance character to the game (null → procedural default)
  async result(){
    if(this._restorePromise) await this._restorePromise;   // don't race an in-flight server restore into a null character
    if(!this.S.model) return {config:null,factory:null};
    const cfg=this.buildConfig(); const clips={}; this.S.embedded.forEach(c=>clips[c.name]=c); for(const [f,{clip}] of this.S.external) clips[f]=clip;
    const factory=await CharacterFactory.fromLoaded(this.S.model,clips,cfg); return {config:cfg,factory}; }

  // Clips embedded IN the model file die with it (they're not separately stored —
  // extracted from the model at load time); clips uploaded separately as their own
  // files (this.S.external) are an independent asset and outlive whatever model is
  // loaded, so only assignments pointing at an embedded clip need to be dropped here.
  _dropEmbeddedAssignments(){ for(const st of Object.keys(this.S.assign)) if(this.S.assign[st].source==='embedded') delete this.S.assign[st]; }

  // Distinct from _resetAll()/"clear saved character" (full wipe, including anims):
  // pulls just the model so a heavy one can be taken down before its replacement is
  // ready, without losing scale/yaw/tint/strip or your uploaded animation files in
  // the meantime. Still tells the server (DELETE .../model, not the full-wipe route),
  // since leaving the old model live there would keep shipping its full poly count to
  // every player until a new one is uploaded.
  async removeModel(){
    if(!this.S.model) return;
    if(this._authed){ try{ await sync.deleteModel(); }catch(e){ this.status('Could not remove on the server: '+e.message,'err'); return; } }
    if(this.S.wrapper) this.scene.remove(this.S.wrapper);
    this.S.model=null; this.S.wrapper=null; this.S.mixer=null; this.S.embedded=[];
    this._dropEmbeddedAssignments();
    this.S.modelName=null; this.S.modelFile=null; this.S.boneNames=new Set(); this.S.isSample=false;
    this.S.current=null; this.S.action=null;
    this.q('.st-empty').classList.remove('gone');
    const mn=this.q('[data-mname]'); mn.style.display='none';
    this.q('[data-rmmodel]').style.display='none';
    this.q('[data-cur]').textContent='—';
    this.refreshAnimList(); this.refreshStates(); this.refreshJSON();
    this.status('Model removed — every player falls back to the default fighter until you upload a new one. Your animation clips are still here.');
  }

  async loadSample(){ this._dropEmbeddedAssignments(); this.refreshAnimList();
    this.S.isSample=true; this.S.modelFile=null;
    this.setModel(buildSampleRig(),buildSampleClips(),'sample-rig (built-in)');
    this.S.scale=1; this.q('[data-scale]').value=1; this.q('[data-scalev]').textContent='1.00'; this.applyScale();
    this.status('Sample loaded — map/preview, or drop your own model',' ok');
    if(this._authed&&!this._restoring){ try{ await sync.useSample(this._settingsSnapshot()); }catch(e){ this.status('Saved locally, but sync failed: '+e.message,'err'); } } }

  _dz(el,fn){ el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('over');});
    el.addEventListener('dragleave',()=>el.classList.remove('over'));
    el.addEventListener('drop',e=>{e.preventDefault();el.classList.remove('over');fn([...e.dataTransfer.files]);}); }
  async _handleModel(files){ const f=files.find(f=>/\.(glb|gltf|fbx)$/i.test(f.name)); if(!f)return;
    try{ this.status('Loading '+f.name+'…'); const a=await this.loadFile(f); this._dropEmbeddedAssignments();
      this.S.isSample=false; this.S.modelFile=f; this.setModel(a.scene,a.animations,f.name);
      if(this._authed&&!this._restoring){ try{ await sync.uploadModel(f,this._settingsSnapshot()); this.status(`Loaded ${f.name} · saved as the game's default character`,'ok'); }
        catch(e){ this.status('Loaded, but saving the default character failed: '+e.message,'err'); } } }
    catch(e){ this.status('Error: '+e.message,'err'); } }
  async _handleAnims(files){ for(const f of files) if(/\.(glb|gltf|fbx)$/i.test(f.name)) await this.addAnim(f); }

  _wire(){
    const q=s=>this.q(s);
    this._dz(q('[data-mdrop]'),f=>this._handleModel(f)); q('[data-mdrop]').addEventListener('click',()=>q('[data-mfile]').click());
    this._dz(q('[data-adrop]'),f=>this._handleAnims(f)); q('[data-adrop]').addEventListener('click',()=>q('[data-afile]').click());
    this._dz(q('.st-view'),f=>this._handleModel(f));
    q('[data-mfile]').addEventListener('change',e=>this._handleModel([...e.target.files]));
    q('[data-afile]').addEventListener('change',e=>this._handleAnims([...e.target.files]));
    q('[data-sfile]').addEventListener('change',e=>{ const f=e.target.files[0]; e.target.value=''; if(f) this._handleAudioUpload(f); });
    q('[data-scale]').addEventListener('input',e=>{ this.S.scale=+e.target.value; q('[data-scalev]').textContent=this.S.scale.toFixed(2); this.applyScale(); this.refreshJSON(); this._schedulePersist(); });
    q('[data-yaw]').addEventListener('input',e=>{ this.S.yaw=+e.target.value; q('[data-yawv]').textContent=Math.round(this.S.yaw*180/Math.PI)+'°'; this.applyYaw(); this.refreshJSON(); this._schedulePersist(); });
    q('[data-tint]').addEventListener('input',e=>{ if(this.S.tint!==null){ this.S.tint=e.target.value; this.applyTint(); this.refreshJSON(); this._schedulePersist(); } });
    q('[data-tintbtn]').addEventListener('click',e=>{ const on=e.target.classList.toggle('on'); e.target.textContent=on?'on':'off'; this.S.tint=on?q('[data-tint]').value:null; this.applyTint(); this.refreshJSON(); this._schedulePersist(); });
    q('[data-strip]').addEventListener('click',e=>{ this.S.strip=e.target.classList.toggle('on'); e.target.textContent=this.S.strip?'on':'off'; this.reStrip(); this.refreshJSON(); this._schedulePersist(); });
    q('[data-rot]').addEventListener('click',e=>{ this.S.autorot=e.target.classList.toggle('on'); });
    q('[data-play]').addEventListener('click',()=>{ this.S.paused=!this.S.paused; q('[data-play]').textContent=this.S.paused?'▶':'❚❚'; });
    q('[data-loop]').addEventListener('click',e=>{ this.S.loop=e.target.classList.toggle('on'); if(this.S.current)this.preview(this.S.current); });
    q('[data-speed]').addEventListener('input',e=>{ this.S.speed=+e.target.value; });
    q('[data-sample]').addEventListener('click',()=>this.loadSample());
    q('[data-rmmodel]').addEventListener('click',()=>this.removeModel());
    q('[data-copy]').addEventListener('click',()=>{ navigator.clipboard?.writeText(q('[data-json]').value); this.status('Config copied','ok'); });
    q('[data-enter]').addEventListener('click',()=>this.onEnter&&this.onEnter());
    q('[data-clear]').addEventListener('click',async()=>{
      if(this._authed){ try{ await sync.deleteCharacter(); }catch(e){ this.status('Could not clear saved character: '+e.message,'err'); return; } }
      this._resetAll();
    });
  }

  // ---- persistence: saved as the game's ONE default character, shown to every player ----
  _settingsSnapshot(){ return { scale:this.S.scale, yaw:this.S.yaw, tint:this.S.tint, strip:this.S.strip, assign:this.S.assign, durations:this.moveDurations(), sizeRatio:this.sizeRatio(), groundOffset:this.groundOffset() }; }
  _schedulePersist(){ if(!this._authed||this._restoring) return; clearTimeout(this._pt); this._pt=setTimeout(()=>this._persistSettings(),400); }
  async _persistSettings(){ try{ await sync.patchSettings(this._settingsSnapshot()); }catch(e){ console.warn('studio: could not save settings',e); this.status('Could not save: '+e.message,'err'); } }

  // tracked on this._restorePromise (set synchronously, before any await) so result()
  // can await an in-flight restore instead of racing it into a null character
  _restoreFromServer(){
    this._restorePromise=this._doRestoreFromServer().finally(()=>{ this._restorePromise=null; });
    return this._restorePromise;
  }
  async _doRestoreFromServer(){
    let data; try{ data=await sync.getDefaultCharacter(); }catch(e){ console.warn('studio: could not read the default character',e); this.status('Could not reach the default character: '+e.message,'err'); return; }
    if(!data || !data.model){ this.status('Signed in as admin — build a character and it becomes the game\'s default for everyone.'); return; }
    this.status('Restoring the game\'s default character…');
    this._restoring=true;
    try{
      if(data.model.kind==='sample') await this.loadSample();
      else if(data.model.kind==='file'){
        const file=await sync.getModelFile();
        this.S.isSample=false; this.S.modelFile=file;
        const a=await this.loadFile(file); this.setModel(a.scene,a.animations,data.model.name);
      }
      this.S.external.clear();
      for(const name of data.anims||[]){
        const file=await sync.getAnimFile(name);
        const a=await this.loadFile(file); const clip=a.animations[0]; if(!clip) continue;
        clip.name=name.replace(/\.[^.]+$/,''); this.strip(clip); this.S.external.set(name,{clip,file});
      }
      this.refreshAnimList();
      if(data.assign) this.S.assign=data.assign;
      if(typeof data.scale==='number'){ this.S.scale=data.scale; this.q('[data-scale]').value=data.scale; this.q('[data-scalev]').textContent=data.scale.toFixed(2); this.applyScale(); }
      if(typeof data.yaw==='number'){ this.S.yaw=data.yaw; this.q('[data-yaw]').value=data.yaw; this.q('[data-yawv]').textContent=Math.round(data.yaw*180/Math.PI)+'°'; this.applyYaw(); }
      if(data.tint!==undefined){ this.S.tint=data.tint; const tb=this.q('[data-tintbtn]'); tb.classList.toggle('on',!!data.tint); tb.textContent=data.tint?'on':'off'; if(data.tint) this.q('[data-tint]').value=data.tint; this.applyTint(); }
      if(typeof data.strip==='boolean'){ this.S.strip=data.strip; const sb=this.q('[data-strip]'); sb.classList.toggle('on',data.strip); sb.textContent=data.strip?'on':'off'; this.reStrip(); }
      this.refreshStates(); this.refreshJSON();
      if(this.S.assign.idle) this.preview('idle'); else { const s=STATES.find(s=>this.S.assign[s]); if(s) this.preview(s); }
      this.status('Restored the default character','ok');
    }catch(e){ console.warn('studio: restore failed',e); this.status('Could not restore the default character: '+e.message,'err'); }
    finally{ this._restoring=false; }
    // self-heal a stale/placeholder sizeRatio/groundOffset (e.g. characters saved
    // before these fields existed) against the model's real, just-measured bounding box
    if(this.S.model && (data.sizeRatio!==this.sizeRatio() || data.groundOffset!==this.groundOffset())) this._schedulePersist();
  }
  _resetAll(){
    if(this.S.wrapper) this.scene.remove(this.S.wrapper);
    this.S={ model:null, wrapper:null, mixer:null, embedded:[], external:new Map(), assign:{},
      scale:1, yaw:0, tint:null, strip:true, modelName:null, boneNames:new Set(),
      current:null, action:null, paused:false, speed:1, loop:true, autorot:false, isSample:false, modelFile:null };
    this.q('[data-scale]').value=1; this.q('[data-scalev]').textContent='1.00';
    this.q('[data-yaw]').value=0; this.q('[data-yawv]').textContent='0°';
    const tb=this.q('[data-tintbtn]'); tb.classList.remove('on'); tb.textContent='off';
    const sb=this.q('[data-strip]'); sb.classList.add('on'); sb.textContent='on';
    this.q('.st-empty').classList.remove('gone'); const mn=this.q('[data-mname]'); mn.style.display='none';
    this.q('[data-rmmodel]').style.display='none';
    this.q('[data-cur]').textContent='—';
    this.refreshAnimList(); this.refreshStates(); this.refreshJSON();
    this.status('Cleared. Drop a rig, or press “Load sample”.');
  }
}
const esc=s=>String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const round=n=>Math.round(n*10000)/10000;
// FBXLoader warns once per vertex with more than 4 bone weights (a GPU skinning
// hardware limit — it already keeps the 4 heaviest and drops the rest correctly, this
// is just it saying so). That's baked into the source file and re-triggers on every
// load since the loader has no cache; re-exporting with weights limited to 4 per
// vertex is the real fix, but that's outside what this code can do. This just quiets
// the known, benign message for the duration of one load — everything else still logs.
// Same deal with "X map is not supported in three.js, skipping texture" (e.g.
// ShininessExponent, common on Mixamo-authored FBX materials).
const BENIGN_FBX_WARNINGS=['more than 4 skinning weights','is not supported in three.js, skipping texture'];
async function quietly(loadFn){
  const orig=console.warn;
  console.warn=(...args)=>{ if(typeof args[0]==='string' && BENIGN_FBX_WARNINGS.some(w=>args[0].includes(w))) return; orig.apply(console,args); };
  try{ return await loadFn(); } finally{ console.warn=orig; }
}
