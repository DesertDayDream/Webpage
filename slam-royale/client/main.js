// App shell: one application with two modes. Studio (admin-only: build the game's ONE
// default character) → Enter match (join the authoritative multiplayer game, rendered
// with the default character — or the admin's in-progress edit, when entering from
// inside the Studio) → back to studio. Everyone else just plays; there's nothing to
// configure per-player anymore.

import { NET, CFG, applyMoveDurations, applyHitboxScale, applyGameConfig, applyMovesBalance } from '../shared/constants.js';
import { emptyCmd } from '../shared/movement.js';
import { Net } from './net.js';
import { View } from './render.js';
import { Studio } from './studio.js';
import * as auth from './auth.js';
import { getDefaultCharacter } from './character-sync.js';
import { getGameConfig } from './game-config-sync.js';
import { SoundBank } from './sound.js';
import { getSoundConfig } from './sound-sync.js';
import { getLobbies } from './lobby-sync.js';

const $ = id => document.getElementById(id);
const menuScreen=$('menuScreen'), studioScreen=$('studioScreen'), gameScreen=$('gameScreen'), gate=$('gate'), end=$('end');
const loadingScreen=$('loadingScreen'), loadingSub=$('loadingSub');
const lobbyListScreen=$('lobbyListScreen'), lobbyWaitScreen=$('lobbyWaitScreen');
const sound = new SoundBank();

let studio=null, view=null, net=null, mode='menu', raf=0, seq=0, acc=0, last=0;
let authEmail=null, authIsAdmin=false, authTab='signin';
const keys=new Set(); let mDX=0,mDY=0, locked=false;
const liveIds=new Set();   // reused every frame instead of allocating a new Set (perf)
let fpsFrames=0, fpsAccum=0, simMsAccum=0, renderMsAccum=0, callsAccum=0, triAccum=0;   // frametime counter: averaged over ~1s, not updated every frame
const oneShot={light1:false,light2:false,light3:false,throw:false,dodge:false,activate:false};
let heldBlock=false;   // Block is a hold — tracked like `keys`, bound to B
let heldAim=false;     // Aim (Q) is also a hold — slows you while lining up a throw, see shared/movement.js
let heldHeavy=false;   // G is a hold too — tap = heavy strike, hold past CFG.grabHoldThreshold = grab (see shared/movement.js's heavyHoldT)

// Bindings (PC): light1/2/3 moved off the mouse onto R/F/V — a diagnostic swap to
// isolate whether something mouse-button-specific was behind reports of light
// presses feeling unreliable (bufAttack/stamina timing were already fixed earlier;
// this rules the input source itself in or out). Bumped Heavy/grab (was F) to G and
// Activate Superstar (was R) to T to make room — mouse buttons are unbound for now.
//   Camera = Mouse · Light 1 = R · Light 2 = F · Light 3 = V ·
// Heavy (tap)/Grab (hold) = G · Block = B · Dodge = C ·
//   Jump = Space · Special Move 1 (aim item) = Q · Special Move 2 (throw item) = E ·
//   Activate Superstar Mode = T
// Every one of these is also a browser/OS shortcut in some combination with a
// modifier key — Ctrl+S saves the page, Ctrl+R reloads it, Ctrl+Q quits the browser
// (macOS) — preventDefault() on every bound key while a match is active closes those
// off. Block was bound to Ctrl once, specifically so it could be HELD alongside WASD —
// but Ctrl+W (close tab) and Cmd+W on Mac are "protected" shortcuts every modern
// browser deliberately refuses to let a page's preventDefault() suppress (so a
// hostile site can never trap a tab shut) — no amount of JS here can stop it. Block
// is on a plain letter key now specifically so holding it alongside W never forms a
// modifier combo at all, not because the old preventDefault() call was wrong.
const BOUND_KEYS=new Set(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','Space',
  'KeyQ','KeyE','KeyR','KeyF','KeyV','KeyG','KeyC','KeyT','KeyB']);
addEventListener('keydown',e=>{ keys.add(e.code); if(mode==='match'){
  if(BOUND_KEYS.has(e.code)) e.preventDefault();
  if(e.code==='KeyQ')heldAim=true; if(e.code==='KeyE')oneShot.throw=true; if(e.code==='KeyT')oneShot.activate=true;
  if(e.code==='KeyG')heldHeavy=true;
  if(e.code==='KeyB')heldBlock=true;
  if(e.code==='KeyC')oneShot.dodge=true;
  if(e.code==='KeyR')oneShot.light1=true; if(e.code==='KeyF')oneShot.light2=true; if(e.code==='KeyV')oneShot.light3=true; } });
addEventListener('keyup',e=>{ keys.delete(e.code); if(e.code==='KeyQ')heldAim=false;
  if(e.code==='KeyG')heldHeavy=false;
  if(e.code==='KeyB')heldBlock=false; });
addEventListener('mousedown',e=>{ if(mode!=='match'||!locked)return;
  if(e.button===1)e.preventDefault(); });   // suppress the browser's native middle-click autoscroll (mouse buttons are otherwise unbound now)
addEventListener('mousemove',e=>{ if(locked){ mDX+=e.movementX; mDY+=e.movementY; } });
addEventListener('contextmenu',e=>{ if(mode==='match')e.preventDefault(); });
document.addEventListener('pointerlockchange',()=>{ locked = !!(view && document.pointerLockElement===view.renderer.domElement); if(gate){ gate.classList.toggle('hidden',locked); } if(!locked){ heldBlock=false; heldAim=false; heldHeavy=false; } });

const down=c=>keys.has(c);
const consumeMouse=()=>{ const d={x:mDX,y:mDY}; mDX=0;mDY=0; return d; };
const consumeShots=()=>{ const s={...oneShot}; oneShot.light1=oneShot.light2=oneShot.light3=oneShot.throw=oneShot.dodge=oneShot.activate=false; return s; };

// main menu: browse lobbies for everyone; Character Studio only shows up for the admin
$('menuPlay').addEventListener('click', enterLobbyBrowser);
$('menuStudio').addEventListener('click', showStudio);
gate.addEventListener('click', ()=>{ sound.resume(); if(mode==='match'&&view) view.renderer.domElement.requestPointerLock(); });

/* ---- account: sign in as the admin to build the game's default character ---- */
function applyAuthState(res){
  authEmail=res.email; authIsAdmin=!!res.isAdmin;
  $('menuStudio').style.display = authIsAdmin ? '' : 'none';
  if(studio) studio.onAuthChange(authIsAdmin);
}
function renderAuth(){
  const el=$('authBox'); if(!el) return;
  if(authEmail){
    el.innerHTML=`<div class="auth-you">Signed in as <b>${esc(authEmail)}</b>${authIsAdmin?' <span style="color:var(--accent)">· admin</span>':''}</div><button class="menu-btn" data-signout>Sign out</button>`;
    el.querySelector('[data-signout]').addEventListener('click', async ()=>{
      try{ await auth.logout(); }catch(e){}
      applyAuthState({email:null,isAdmin:false}); renderAuth();
    });
    return;
  }
  el.innerHTML=`
    <div class="auth-tabs">
      <button class="auth-tab ${authTab==='signin'?'on':''}" data-tab="signin">Sign in</button>
      <button class="auth-tab ${authTab==='signup'?'on':''}" data-tab="signup">Create account</button>
    </div>
    <input type="email" placeholder="email" autocomplete="email" data-email>
    <input type="password" placeholder="password (8+ characters)" autocomplete="${authTab==='signin'?'current-password':'new-password'}" data-password>
    <button class="menu-btn pri" data-submit>${authTab==='signin'?'Sign in':'Create account'}</button>
    <div class="auth-msg" data-msg></div>`;
  el.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{ authTab=b.dataset.tab; renderAuth(); }));
  const submit=async()=>{
    const email=el.querySelector('[data-email]').value.trim(), password=el.querySelector('[data-password]').value;
    const msg=el.querySelector('[data-msg]'); msg.className='auth-msg'; msg.textContent='Working…';
    try{
      const res = authTab==='signin' ? await auth.login(email,password) : await auth.signup(email,password);
      applyAuthState(res); renderAuth();
    }catch(e){ msg.textContent=e.message; }
  };
  el.querySelector('[data-submit]').addEventListener('click', submit);
  el.querySelector('[data-password]').addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}
function esc(s){ return String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
(async()=>{ try{ applyAuthState(await auth.me()); }catch(e){} renderAuth(); })();

function menuError(e){ console.error(e); const el=$('menuErr'); if(!el)return;
  el.style.display='block'; el.textContent='Something went wrong: '+(e&&e.message||e); }

function showMenu(){
  mode='menu'; cancelAnimationFrame(raf); clearInterval(lobbyPollTimer);
  try{ document.exitPointerLock(); }catch(e){}
  if(net){ net.disconnect(); net=null; }
  if(view){ view.dispose(); view=null; }
  preloadToken++;   // invalidate any in-flight preload — see startPreload()
  if(studio) studio.stop();
  const warn=$('charWarn'); if(warn){ warn.classList.remove('show'); clearTimeout(warn._t); }
  gameScreen.style.display='none'; studioScreen.style.display='none'; loadingScreen.style.display='none';
  lobbyListScreen.style.display='none'; lobbyWaitScreen.style.display='none'; menuScreen.style.display='flex';
}
function showStudio(){
  menuScreen.style.display='none'; gameScreen.style.display='none'; studioScreen.style.display='flex';
  try{
    // Studio's "Enter match →" bypasses the lobby entirely (a solo room that skips
    // the wait — see server/rooms.js's createSoloRoom()), so the admin gets the same
    // instant in-progress-character preview they always have.
    if(!studio){ studio = new Studio(studioScreen, ()=>joinRoom(undefined, undefined, true)); studio.onAuthChange(authIsAdmin); }
    else studio.start();
  }catch(e){ studioScreen.style.display='none'; menuScreen.style.display='flex'; menuError(e); return; }
  mode='studio';
  const back=$('studioBackBtn'); if(back && !back._wired){ back._wired=true; back.addEventListener('click', showMenu); }
}
$('backBtn').addEventListener('click', showMenu);

function showLoading(text){ if(loadingSub) loadingSub.textContent=text; loadingScreen.style.display='flex'; }
function hideLoading(){ loadingScreen.style.display='none'; }

/* ---- lobby browser: multi-room matchmaking (see server/rooms.js) ---- */
let lobbyPollTimer=0, preloadToken=0, preloadPromise=null;

async function enterLobbyBrowser(){
  if(net){ net.disconnect(); net=null; }
  if(view){ view.dispose(); view=null; }
  preloadToken++;   // invalidate any in-flight preload — see startPreload()
  if(studio) studio.stop();
  mode='lobbyList';
  menuScreen.style.display='none'; studioScreen.style.display='none'; gameScreen.style.display='none';
  loadingScreen.style.display='none'; lobbyWaitScreen.style.display='none'; lobbyListScreen.style.display='flex';
  await refreshLobbyList();
  clearInterval(lobbyPollTimer);
  lobbyPollTimer = setInterval(()=>{ if(mode==='lobbyList') refreshLobbyList(); }, 2000);
}
async function refreshLobbyList(){
  const listEl=$('lobbyList'), emptyEl=$('lobbyEmpty'), errEl=$('lobbyListErr');
  try{
    const { rooms } = await getLobbies();
    errEl.style.display='none';
    emptyEl.style.display = rooms.length ? 'none' : 'block';
    listEl.innerHTML = rooms.map(r=>`<div class="lobby-row" data-room="${r.id}">
      <span>Lobby ${esc(r.id)}${r.phase==='starting'?' · starting…':''}</span>
      <span class="n">${r.count}/${r.max} · ${r.countdownT}s</span></div>`).join('');
    listEl.querySelectorAll('[data-room]').forEach(row=>row.addEventListener('click', ()=>joinRoom(row.dataset.room, {config:null,factory:null})));
  }catch(e){ errEl.style.display='block'; errEl.textContent='Could not reach the lobby list: '+e.message; }
}
$('lobbyQuickJoin').addEventListener('click', ()=>joinRoom(undefined, {config:null,factory:null}));
$('lobbyBackBtn').addEventListener('click', showMenu);
$('lobbyLeaveBtn').addEventListener('click', enterLobbyBrowser);

// roomId omitted = auto-assign (quick join / Studio solo); built omitted = Studio's
// solo bypass, which needs to await studio.result() itself (same as enterMatch() used
// to). solo=true skips the wait server-side (see server/rooms.js's createSoloRoom()).
async function joinRoom(roomId, built, solo=false){
  if(mode==='match') return;
  clearInterval(lobbyPollTimer);
  if(studio) studio.stop();
  menuScreen.style.display='none'; studioScreen.style.display='none'; lobbyListScreen.style.display='none';
  mode='lobbyWait';
  let res=built;
  if(res===undefined){ try{ res = await studio.result(); }catch(e){ console.warn('character build failed → default brawler', e); res={config:null,factory:null}; } }
  updateLobbyWaitUI({ phase:'waiting', players:[], count:0, max:CFG.maxPlayers, countdownT:0 });
  lobbyWaitScreen.style.display='flex';
  // Preload everything a match needs (character model/clips, match balance, sound)
  // the moment we're in ANY lobby-wait state, not just once the room hits 'starting'
  // — the lobby's own wait time (up to CFG.lobbyCountdown, often much longer than the
  // fixed starting buffer) was otherwise being completely wasted, and this is easily
  // the slowest part of getting into a match. Runs silently behind the lobby-wait
  // screen; beginLoadingAndEnter() below awaits this and only shows an actual loading
  // screen for whatever's left, if anything, once the room actually starts.
  preloadPromise = startPreload(res);
  net = new Net();
  net.onLobby = onLobbyUpdate;
  net.onReject = onLobbyReject;
  net.connect('Player', res.config, roomId, solo);
}
function updateLobbyWaitUI(m){
  $('lobbyWaitPhase').textContent = m.phase==='starting' ? 'Starting…' : 'Waiting for players…';
  $('lobbyWaitCount').textContent = `${m.count} / ${m.max} joined`;
  $('lobbyWaitCountdown').textContent = m.phase==='starting' ? '—' : Math.ceil(m.countdownT)+'s';
  $('lobbyWaitPlayers').innerHTML = (m.players||[]).map(p=>esc(p.name||p.id)).join('<br>');
}
function onLobbyUpdate(m){
  updateLobbyWaitUI(m);
  // The room only ever broadcasts LOBBY once with phase 'starting' (see
  // server/rooms.js's Room.tick()) — after that it's asset-loading time. There's no
  // separate "now active" message; the first SNAPSHOT arriving is that signal (see
  // net.js's _recv()), which is why beginLoadingAndEnter() doesn't wait for it —
  // by the time asset loading finishes, the server's own fixed starting buffer has
  // usually already elapsed too.
  if(m.phase==='starting') beginLoadingAndEnter();
}
function onLobbyReject(reason){
  if(net){ net.disconnect(); net=null; }
  enterLobbyBrowser();
  const el=$('lobbyListErr'); if(el){ el.style.display='block'; el.textContent=`Could not join that lobby (${reason}) — here's an updated list.`; }
}

// Does the actual work joinRoom() kicks off as soon as we enter the lobby (see
// startPreload() below) — model/clips, match balance, and sound, all loaded up front
// instead of waiting for the room to reach 'starting'. res.config is the admin's live
// in-Studio edit when present; everyone else (and the admin via solo preview) uses
// whatever's currently persisted as the default.
async function preloadAssets(res){
  // move durations + hit reach must match the server's before the loop starts ticking,
  // or client prediction disagrees with authority from frame one (see shared/constants.js).
  let charCfg = res.config;
  if(!charCfg){ try{ charCfg = await getDefaultCharacter(); }catch(e){ console.warn('could not load default character config, using defaults',e); charCfg=null; } }
  applyMoveDurations(charCfg?.durations || {});
  applyHitboxScale(charCfg?.sizeRatio ?? 1);
  // same requirement as above: match balance (movement/input/zone/items/superstar +
  // per-move combat balance) also feeds stepBody(), so it must be in place before
  // ticking starts too
  try{ const gc=await getGameConfig(); applyGameConfig(gc); applyMovesBalance(gc.moves||{}); }
  catch(e){ console.warn('could not load match balance config, using defaults',e); applyGameConfig({}); applyMovesBalance({}); }
  // best-effort: a missing/failed sound cue should never block getting into the match
  try{ const sc=await getSoundConfig(); await sound.load(sc); }
  catch(e){ console.warn('could not load sound config',e); }
  const v = new View($('app')); if(res.factory) v.setLocalFactory(res.factory);
  v.onLocalCharError = e => showCharWarn('Your custom character failed to load — using the default fighter. ('+e.message+')');
  await v.sharedFactoryPromise;   // resolves to null on failure — never rejects, see render.js
  return v;
}
// Tags the resulting View with a token so an ABANDONED attempt (left the lobby, or
// joined a different one, before this finished) disposes its half-built View instead
// of leaking a WebGL context nobody will ever use — enterLobbyBrowser()/showMenu()
// bump preloadToken on the way out, which is what makes an in-flight preload "stale"
// by the time it resolves.
function startPreload(res){
  const myToken = ++preloadToken;
  return preloadAssets(res).then(v => {
    if (myToken !== preloadToken){ v.dispose(); return null; }
    return v;
  });
}

async function beginLoadingAndEnter(){
  lobbyWaitScreen.style.display='none';
  // Usually already finished by now — preloading started back when the lobby was
  // first entered (see joinRoom()), and the lobby's own wait time is typically much
  // longer than loading takes. This only actually shows for however long is left, if
  // anything, on a slow connection where loading outran the lobby wait.
  showLoading('Loading…');
  try{
    view = await preloadPromise;
    if(!view) throw new Error('preload was abandoned');   // see startPreload() — shouldn't happen this late in practice
  }catch(e){ hideLoading(); menuError(e); showMenu(); return; }
  hideLoading();
  gameScreen.style.display='block'; mode='match';
  end.classList.remove('show'); gate.classList.remove('hidden');
  clearTimeout(end._autoT); $('endSpectateBtn').style.display='none';
  seq=0; acc=0; last=performance.now();
  raf = requestAnimationFrame(loop);
}

/* ---- match loop ---- */
function sampleCmd(shots){ const cmd=emptyCmd(); const yaw=view.cam.yaw, s=Math.sin(yaw), c=Math.cos(yaw);
  let ax=(down('KeyD')?1:0)-(down('KeyA')?1:0), az=(down('KeyS')?1:0)-(down('KeyW')?1:0); const l=Math.hypot(ax,az); if(l>1){ax/=l;az/=l;}
  cmd.moveX=ax*c+az*s; cmd.moveZ=-ax*s+az*c; cmd.sprint=down('ShiftLeft')||down('ShiftRight');
  cmd.block=heldBlock; cmd.jump=down('Space'); cmd.aim=heldAim; cmd.heavyHeld=heldHeavy;
  cmd.light1=shots.light1; cmd.light2=shots.light2; cmd.light3=shots.light3;
  cmd.throw=shots.throw; cmd.dodge=shots.dodge; cmd.activate=shots.activate; cmd.pitch=view.cam.pitch; return cmd; }

function loop(now){
  raf=requestAnimationFrame(loop);
  const raw=Math.min((now-last)/1000,0.1); last=now;
  const tSimStart=performance.now();

  // Simulate/sync is wrapped defensively: view.render() below must always run every
  // frame, even if something here throws, so a single bad frame can never permanently
  // black-screen/freeze the match (this bit us before — see render.js's syncFighter).
  try{
    // consumeShots() clears the sticky one-shot key-press flags (light1/2/3, throw,
    // dodge, activate) — it must only fire once a tick is actually about to consume
    // them, not unconditionally every render frame. On any display faster than the
    // 60Hz fixed sim rate (120/144Hz is common), most frames don't accumulate a full
    // NET.FIXED_DT and the while loop below never runs — clearing the flags anyway
    // (the old behavior) silently ate a press that no tick ever saw, needing a second
    // press to land on a frame that actually ticks.
    acc+=raw; let first=true, steps=0;
    while(acc>=NET.FIXED_DT && net.joined && net.phase==='active'){ acc-=NET.FIXED_DT; seq++;
      const cmd=sampleCmd(first?consumeShots():{light1:false,light2:false,light3:false,throw:false,dodge:false,activate:false}); first=false;
      net.tick(seq,cmd,NET.FIXED_DT); if(++steps>10){ acc=0; break; } }   // ~166ms of catch-up tolerance at 60Hz, same as the old 5-step cap at 30Hz

    for(const ev of net.drainEvents()){
      // Server-broadcast events (hit/grab/block/ko/end, pickups) fire for whichever
      // fighter they actually happened to — local or remote — unlike the 'sfx' events
      // below, which are pushed from net.js's local prediction and only ever cover
      // the local player's own actions.
      if(ev.e==='hit'||ev.e==='grab'){ view.spark(ev.x,ev.z, ev.e==='grab'?0xff5533:0xffcc55, ev.e==='grab'?1.3:0.8);
        if(ev.t===net.selfId||ev.a===net.selfId) view.shake(ev.e==='grab'?0.6:0.22);
        if(ev.t===net.selfId) flash(ev.e==='grab'?0.5:0.28);
        sound.play(ev.e==='grab'?'grabbed':'hit', ev.dur);
      } else if(ev.e==='block'){ view.spark(ev.x,ev.z,0x88ccff,0.5); sound.play('block'); }
      // clash: a mutual "no damage, no blame" bounce (see server/world.js's
      // applyClash()) — a bright white-gold spark + shake for weight, but no red
      // flash(), since unlike hit/grab that vignette specifically means "you took
      // damage," which didn't happen to either fighter here.
      else if(ev.e==='clash'){ view.spark(ev.x,ev.z,0xffffff,1.0);
        if(ev.t===net.selfId||ev.a===net.selfId) view.shake(0.4);
        sound.play('clash', ev.dur); }
      // net.over is already set from this same snapshot by the time events are drained
      // (see net.js's _snapshot()) — so if this death happened to be the one that also
      // ends the whole match (this player wasn't the survivor, but was the second-to-
      // last death), the 'end' event below takes over instead of this personal card.
      else if(ev.e==='ko'){ sound.play('dead', ev.dur); if(ev.t===net.selfId && !net.over) showKoEnd(); }
      else if(ev.e==='itemPickup'){ if(ev.t===net.selfId) sound.play('itemPickup'); }
      else if(ev.e==='orbPickup'){ if(ev.t===net.selfId) sound.play('orbPickup'); }
      else if(ev.e==='sfx'){ sound.play(ev.slot, ev.dur); }   // ev.dur is only set for the moves that actually have one (see net.js) — undefined elsewhere plays out naturally
      else if(ev.e==='denied'){ sound.play('staminaDenied'); staminaDenyFlash(); }
      else if(ev.e==='end'){ sound.play(net.winner===net.selfId?'matchWin':'matchLose'); showEnd(); }
      else if(ev.e==='battleStart'){ sound.play('battleStart'); battleFlash(); }
    }

    if(net.joined){
      const b=net.local;
      // b only advances at the fixed 30Hz sim tick; extrapolate the rendered position
      // by the leftover accumulator time so the local player (and the camera, which
      // tracks this same rendered position) moves smoothly at full frame rate instead
      // of visibly stepping every ~33ms. Reconciliation/prediction math is untouched —
      // this only changes what gets drawn. Skip extrapolation during hitstop — the sim
      // is frozen, so the position shouldn't visually creep forward either.
      const ext=b.hitstop>0?0:acc;
      net.decayPosError(raw);
      const disp={ x:b.x+b.vx*ext+net.posError.x, y:b.y+b.vy*ext+net.posError.y, z:b.z+b.vz*ext+net.posError.z, rotY:b.rotY };
      view.syncFighter(net.selfId, disp, {alive:b.alive,action:b.action,ap:b.ap,vy:b.vy,grounded:b.grounded,speed:Math.hypot(b.vx,b.vz),hitstop:b.hitstop,superstarActive:!!b.superstarActive,carrying:!!b.carrying}, raw, net.selfChar, true);
      view.updateTrajectory(disp.x, disp.y, disp.z, disp.rotY, view.cam.pitch, !!b.aiming);
      liveIds.clear(); liveIds.add(net.selfId);
      let aliveCount=b.alive?1:0;
      for(const id of net.remotes.keys()){
        const r=net.sampleRemote(id); if(!r)continue; liveIds.add(id);
        if(r.alive) aliveCount++;
        view.syncFighter(id, r, {alive:!!r.alive,action:r.action,ap:r.ap,vy:0,grounded:true,speed:r.speed,hitstop:r.hitstop,superstarActive:!!r.superstarActive,carrying:!!r.carrying}, raw, net.roster.get(id), false);
      }
      view.removeMissing(liveIds); view.syncWorldItems(net.items,net.orbs,net.projectiles,raw); hud(aliveCount);
      updateCountdown();
    }
    status(net.status);
  }catch(e){ console.error('match loop error:', e); }

  const tRenderStart=performance.now();
  const tgt = view.fighterObj(net.selfId) || {x:0,y:0,z:0};
  view.render(raw, consumeMouse(), tgt);
  const tEnd=performance.now();

  // frametime/FPS counter: averaged over ~1s and only touches the DOM once/sec, so the
  // counter itself can't be the thing making frametime worse. Split into sim (physics/
  // prediction/animation-state JS) vs render (renderer.render() — draw calls, GPU
  // submission) so a frametime spike can actually be traced to one side or the other,
  // instead of guessing.
  // renderer.info.render is reset by three.js at the start of every render() call, so
  // reading it right after render() gives this frame's actual draw-call/triangle count
  // — real numbers instead of guessing at mesh counts by eye.
  const ri=view.renderer.info.render;
  fpsFrames++; fpsAccum+=raw; simMsAccum+=(tRenderStart-tSimStart); renderMsAccum+=(tEnd-tRenderStart);
  callsAccum+=ri.calls; triAccum+=ri.triangles;
  if(fpsAccum>=1){ const el=$('fpsCounter'); if(el) el.textContent=
      `${(fpsFrames/fpsAccum).toFixed(0)} fps · ${(1000*fpsAccum/fpsFrames).toFixed(1)} ms (sim ${(simMsAccum/fpsFrames).toFixed(1)} / render ${(renderMsAccum/fpsFrames).toFixed(1)}) · ${(callsAccum/fpsFrames).toFixed(0)} calls / ${(triAccum/fpsFrames/1000).toFixed(1)}k tris`;
    fpsFrames=0; fpsAccum=0; simMsAccum=0; renderMsAccum=0; callsAccum=0; triAccum=0; }
}

/* ---- HUD ---- */
function status(t){ const el=$('netStatus'); if(el) el.textContent=t; }
function hud(aliveCount){ const b=net.local;
  $('hpFill').style.transform=`scaleX(${Math.max(0,b.hp/b.maxHp)})`;
  $('stFill').style.transform=`scaleX(${Math.max(0,b.stam/b.maxStam)})`;
  const bsFill=$('bsFill'); if(bsFill) bsFill.style.transform=`scaleX(${Math.max(0,b.blockStam/b.maxBlockStam)})`;
  $('lvl').innerHTML=`LVL <b>${b.level}</b>`;
  $('alive').innerHTML=`${aliveCount} <small>ALIVE</small>`;
  // b.combo is "which slot to use next" (cycles 0→1→2→0 via modulo), not "hits landed" —
  // on the 3rd hit it's already wrapped back to 0, which used to read as "no combo" and
  // hide the counter on exactly the hit it should show ×3. Recover the real hit number
  // instead of displaying the raw wraparound value.
  const hitsLanded = ((b.combo+2)%3)+1;   // always 1-3 — the gate is comboT, not this
  if(b.comboT>0){ $('combo').textContent=`COMBO ×${hitsLanded}`; $('combo').style.opacity=1; } else $('combo').style.opacity=0;
  const ssFill=$('ssFill'), ssBar=$('ssBar');
  if(ssFill) ssFill.style.transform=`scaleX(${Math.max(0,Math.min(1,b.superstar/CFG.superstarMax))})`;
  if(ssBar) ssBar.classList.toggle('ready', b.superstar>=CFG.superstarMax && !b.superstarActive);
  if(ssBar) ssBar.classList.toggle('active', !!b.superstarActive);
  const carry=$('carrying'); if(carry) carry.classList.toggle('show', !!b.carrying);
}
function flash(v){ const el=$('hitflash'); el.style.background=`radial-gradient(120% 90% at 50% 55%,transparent 45%,rgba(229,72,77,${v}))`;
  setTimeout(()=>el.style.background='radial-gradient(120% 90% at 50% 55%,transparent 55%,rgba(229,72,77,0))',80); }
// Distinct, targeted cue for "that press was rejected for low stamina" — pulses the
// stamina bar itself (not a screen-wide flash like getting hit) so it's obvious WHICH
// resource is why the press didn't register.
function staminaDenyFlash(){ const el=$('stBar'); if(!el) return;
  el.classList.remove('deny'); void el.offsetWidth; el.classList.add('deny');
  // #stBar.deny's border-color/box-shadow (index.html) are plain CSS, not part of the
  // stDeny keyframe animation (that only covers the shake) — they never revert on
  // their own once the animation finishes playing, so the class has to be removed by
  // hand once its 300ms (matching the CSS's own .3s) is up, or the red outline just
  // stays on the stamina bar forever. clearTimeout guards a rapid retrigger (another
  // denied press before this one's timeout fires) from having its OWN removal
  // clobbered by this call's now-stale one.
  clearTimeout(el._denyT); el._denyT=setTimeout(()=>el.classList.remove('deny'),300); }
// The countdown NUMBER (3, 2, 1) is driven every frame straight off net.countdownT
// (server-authoritative, see server/world.js) in updateCountdown() below — this is
// the separate, ONE-TIME "BATTLE!" sting fired by the 'battleStart' event the instant
// that countdown hits 0. Owns #countdown's visibility for its own fixed flash window
// via the 'battle' class; updateCountdown() below defers to it while that class is
// present instead of fighting over show/hide the same frame both would otherwise run.
function battleFlash(){ const el=$('countdown'); if(!el) return;
  $('cdNum').textContent='BATTLE!'; el.classList.add('show','battle');
  clearTimeout(el._bt); el._bt=setTimeout(()=>el.classList.remove('show','battle'),900); }
function updateCountdown(){ const el=$('countdown'); if(!el || el.classList.contains('battle')) return;
  if(net.countdownT>0){ el.classList.add('show'); $('cdNum').textContent=Math.ceil(net.countdownT); }
  else el.classList.remove('show'); }
function showCharWarn(msg){ const el=$('charWarn'); if(!el) return;
  el.textContent=msg; el.classList.add('show');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),6000); }
// Rooms are destroyed after a match ends, not recycled (see server/rooms.js) — so
// unlike the old single-persistent-world days, there's no "next match" to just sit
// and wait for. The player clicks Continue when they're ready (endContinueMusic below
// cuts the win/lose music right at that click, instead of letting it play on into the
// lobby); a long fallback timer covers anyone who never clicks a FINAL result — a
// personal early KO (showKoEnd() below) has no such timer, since spectating
// indefinitely is a legitimate choice, not something to be timed out of.
let endMusicSlot=null;
function showEnd(){ const win=net.winner===net.selfId;
  endMusicSlot = win?'matchWin':'matchLose';
  $('endTitle').textContent=win?'Last one standing':'You got knocked out'; $('endTitle').className='huge '+(win?'win':'lose');
  $('endSub').textContent='Click continue to return to the lobby.';
  $('endSpectateBtn').style.display='none';
  end.classList.add('show');
  clearTimeout(end._autoT); end._autoT=setTimeout(endContinue,15000); try{ document.exitPointerLock(); }catch(e){} }
// Fires the instant YOUR OWN fighter dies while the match keeps going for everyone
// else — previously this gave no feedback at all until the match eventually ended,
// which could be minutes later. Plays the same 'matchLose' sting a final loss would —
// from this player's own perspective their part in the match IS decided, even though
// the match as a whole isn't yet — so it's tracked in endMusicSlot the same way, and
// gets cut by whichever button ends up dismissing this card (below).
function showKoEnd(){
  endMusicSlot='matchLose'; sound.play('matchLose');
  $('endTitle').textContent='You got knocked out'; $('endTitle').className='huge lose';
  $('endSub').textContent='Head back to the lobby, or keep watching how the match plays out.';
  // inline-block (not 'block'): a block-level button ignores .card's text-align:center
  // entirely (that only centers inline/inline-block content) and instead just sits
  // flush against the container's left edge — exactly the off-center look this was.
  $('endSpectateBtn').style.display='inline-block';
  end.classList.add('show');
  clearTimeout(end._autoT);   // no forced auto-continue here — spectating is a valid choice
  try{ document.exitPointerLock(); }catch(e){} }
function endContinue(){ clearTimeout(end._autoT);
  if(endMusicSlot){ sound.stop(endMusicSlot); endMusicSlot=null; }
  end.classList.remove('show'); enterLobbyBrowser(); }
// Dismisses the personal-KO card without leaving — the match keeps running exactly
// as it was (camera/rendering/audio never stopped in the first place, only combat
// input was already being ignored server-side for a dead body), and #gate's own
// "click to lock the cursor" overlay is already sitting there ready to resume camera
// control (pointerlockchange's handler un-hides it the moment pointer lock exits,
// which showKoEnd() above already triggered). If the match later actually ends,
// the real 'end' event still fires showEnd() and replaces this regardless. Cuts the
// lose sting same as Continue does — spectating should hear the ongoing match, not
// this player's own "you lost" sting still ringing over it.
function endSpectate(){ if(endMusicSlot){ sound.stop(endMusicSlot); endMusicSlot=null; } end.classList.remove('show'); }
$('endSpectateBtn').addEventListener('click', endSpectate);
$('endContinueBtn').addEventListener('click', endContinue);
