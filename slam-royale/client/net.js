// Client networking: talks to the authoritative server, predicts the local player,
// and interpolates everyone else. This is the piece that hides latency.
//
//   PREDICTION      – apply our own inputs locally the instant we make them, so the
//                     character responds with zero perceived lag.
//   RECONCILIATION  – each snapshot, snap the local body to the server's authoritative
//                     state, then replay the inputs the server hasn't acknowledged yet.
//   INTERPOLATION   – render remote players ~100ms in the past, smoothly between the
//                     two surrounding snapshots, so packet jitter never shows.

import { NET, MSG, MOVES, CFG } from '../shared/constants.js';
import { newBody, stepBody, emptyCmd } from '../shared/movement.js';

export class Net {
  constructor(){
    this.ws = null;
    this.joined = false;
    this.selfId = null;
    this.local = newBody();        // our predicted body
    this.pending = [];             // [{seq, cmd}] inputs not yet acknowledged
    this.remotes = new Map();      // id -> [{t, body}] interpolation buffers
    this.radius = 38;
    this.over = false; this.winner = null; this.countdownT = 0;   // battle countdown — see server/world.js
    this.events = [];              // FX events drained by the renderer each frame
    this.status = 'connecting';
    this.onWelcome = null;
    // Lobby state (see server/rooms.js) — 'lobby' until WELCOME arrives, then whatever
    // the room's LOBBY broadcasts say ('waiting'/'starting') until the first SNAPSHOT
    // arrives, which can only ever happen once the room is genuinely 'active' (no
    // separate "now active" message exists — receiving a snapshot at all IS the signal).
    this.roomId = null; this.phase = 'lobby';
    this.lobbyPlayers = []; this.lobbyCountdownT = 0; this.lobbyMax = 0;
    this.rejectReason = null; this.onLobby = null; this.onReject = null;
    this.roster = new Map();       // id -> character config (for rendering remotes)
    this.selfChar = null;
    this.posError = {x:0,y:0,z:0}; // visual-only smoothing for reconciliation snaps — see _snapshot()
    // world state (items/orbs/thrown projectiles) — just the latest snapshot, no
    // interpolation needed: pickups barely move (nothing to smooth) and projectiles
    // are cosmetic in flight (their actual hit is resolved server-side regardless of
    // how smoothly the client draws them)
    this.items = []; this.orbs = []; this.projectiles = [];
  }

  // A hard reconciliation correction (e.g. the server's authoritative fighter-vs-
  // fighter collision push in server/world.js's resolveCollisions(), which local
  // prediction can't replicate — it only ever has stale/interpolated remote positions
  // to check against) would otherwise be an instant teleport every ~33ms for as long
  // as you're overlapping someone. Decaying this toward zero each frame turns that
  // into an imperceptible ease instead — gameplay (hp/action/hit detection) still
  // uses the true corrected position immediately; only what gets drawn eases in.
  decayPosError(dt){ const k=Math.exp(-20*dt); this.posError.x*=k; this.posError.y*=k; this.posError.z*=k; }

  // roomId: join a specific open room (from the lobby browser); omitted = auto-assign
  // to any open room, creating a new one if none exists. solo: Studio's instant-preview
  // bypass — creates a fresh room that skips the wait entirely (see server/rooms.js).
  connect(name, char, roomId, solo){
    this.selfChar = char || null;
    // window.SLAM_API_BASE (set by the embedding page, e.g. when this client is
    // served from a different origin than the Railway-hosted server — see
    // character-sync.js's same convention) overrides same-origin, matching
    // shared/mount.js's WS_PATH ('/slam-royale/ws') on the server side. Standalone
    // local dev (no SLAM_API_BASE set, server/server.js's unscoped
    // WebSocketServer) doesn't filter by path at all, so appending it there is
    // always harmless.
    const base = (typeof window!=='undefined' && window.SLAM_API_BASE) || (location.protocol+'//'+location.host);
    const proto = base.startsWith('https') ? 'wss:' : 'ws:';
    const host = base.replace(/^https?:\/\//, '');
    this.ws = new WebSocket(`${proto}//${host}/slam-royale/ws`);
    this.ws.onopen = () => { this.status='connected'; this.ws.send(JSON.stringify({ type:MSG.JOIN, name, char: this.selfChar, roomId, solo })); };
    this.ws.onclose = () => { this.status='disconnected'; this.joined=false; };
    this.ws.onerror = () => { this.status='error'; };
    this.ws.onmessage = e => this._recv(JSON.parse(e.data));
  }

  _recv(m){
    if (m.type === MSG.WELCOME){
      this.selfId = m.id; this.roomId = m.roomId; this.joined = true; this.status='in lobby';
      this.onWelcome && this.onWelcome(m);
    } else if (m.type === MSG.LOBBY){
      this.phase = m.phase; this.lobbyPlayers = m.players; this.lobbyCountdownT = m.countdownT; this.lobbyMax = m.max;
      this.status = m.phase==='starting' ? 'starting' : 'in lobby';
      this.onLobby && this.onLobby(m);
    } else if (m.type === MSG.JOIN_REJECTED){
      this.rejectReason = m.reason; this.status='rejected';
      this.onReject && this.onReject(m.reason);
    } else if (m.type === MSG.ROSTER){
      this.roster = new Map(Object.entries(m.roster || {}));
    } else if (m.type === MSG.SNAPSHOT){
      // no separate "now active" message exists — a snapshot can only ever arrive once
      // the room's phase is genuinely 'active' server-side, so receiving one at all IS
      // that signal (see server/rooms.js's Room.tick()).
      this.phase = 'active'; this.status = 'in match';
      this._snapshot(m.s, m.ack);
    }
  }

  // called from the fixed-step loop: record + send input, and predict locally
  tick(seq, cmd, dt){
    if (!this.joined || this.phase!=='active') return;
    this.pending.push({ seq, cmd });
    // snapshot BEFORE stepBody so _logCombat can tell what actually changed — taken
    // here (not inside stepBody itself) because this is the one call site that runs
    // exactly once per genuinely new input; the reconciliation replay in _snapshot()
    // calls stepBody too, but logging there would print the same event repeatedly
    // for as long as that input stays unacknowledged.
    const prev = { action:this.local.action, combo:this.local.combo, stam:this.local.stam, heavyHoldT:this.local.heavyHoldT, lightCooldownT:{...this.local.lightCooldownT}, grounded:this.local.grounded, superstarActive:this.local.superstarActive };
    stepBody(this.local, cmd, dt);
    this._logCombat(cmd, prev);
    this._playActionSounds(prev);
    this.ws.send(JSON.stringify({ type:MSG.INPUT, seq, cmd }));
  }

  // Sound cues for the LOCAL player's own predicted actions (shared/audio.js's
  // SOUND_SLOTS) — pushed as generic {e:'sfx', slot, dur} events, same drain pipeline
  // as 'denied' (see main.js), rather than importing SoundBank here directly.
  // Reactions to being hit/grabbed/blocked, KO, pickups, and match end are all
  // server-broadcast events instead (see server/world.js/main.js) — they need to fire
  // correctly regardless of who they happen to, not just what the local prediction
  // guessed. `dur` (where it's a meaningful concept — see main.js's SoundBank.play())
  // is just b.dur: the SAME authoritative duration the action itself is timed against,
  // so the sample gets cut off at the exact moment the animation does, not whenever
  // the sample itself happens to end.
  _playActionSounds(prev){
    const b=this.local;
    // aEl===0 alone (not "name changed") catches a move canceling into another
    // instance of itself too (heavy → heavy), same reasoning as _logCombat's justBegan.
    const soundOnBegin={ light1:'light1', light2:'light2', light3:'light3', heavy:'heavy', grab:'grabStart', superAttack:'superAttack', dodge:'dodge', throw:'throw', stunned:'stunned' };
    if (soundOnBegin[b.action] && b.aEl===0) this.events.push({ e:'sfx', slot:soundOnBegin[b.action], dur:b.dur });
    if (b.action==='block' && prev.action!=='block') this.events.push({ e:'sfx', slot:'guardUp' });
    if (prev.grounded && !b.grounded && b.vy>0) this.events.push({ e:'sfx', slot:'jump' });
    else if (!prev.grounded && b.grounded) this.events.push({ e:'sfx', slot:'land' });
    if (!prev.superstarActive && b.superstarActive) this.events.push({ e:'sfx', slot:'superstarActivate' });
  }

  // Console diagnostics for tuning combo/heavy/grab/dodge feel — not a UI feature, just
  // visibility into what the sim actually decided vs. what you pressed. Open devtools.
  _logCombat(cmd, prev){
    const b=this.local, atkStates=['light1','light2','light3','heavy','grab'];
    // begin() sets aEl to exactly 0, and nothing increments it again within the same
    // stepBody call — so aEl===0 means a fresh instance of this action just started
    // THIS tick. Checking the action NAME changed isn't enough: a move canceling into
    // another copy of itself (heavy → heavy) keeps the same name, and that's exactly
    // the case worth catching here.
    const justBegan = atkStates.includes(b.action) && b.aEl===0;
    if (justBegan){
      // light1/2/3 are 3 independently-bound attacks now (see client/main.js), not a
      // forced sequence — the streak number here tracks CONSECUTIVE hits landed (same
      // ((combo+2)%3)+1 cycle the HUD's "COMBO ×N" popup uses in main.js), regardless
      // of which of the 3 you actually threw.
      const isLight = b.action==='light1'||b.action==='light2'||b.action==='light3';
      const hitNum = isLight ? ((b.combo+2)%3)+1 : null;
      console.log(`%c[combat] ${b.action} started${hitNum?` — combo hit ${hitNum}/3`:''} — stam ${prev.stam.toFixed(0)}→${b.stam.toFixed(0)}`,'color:#8ecbff');
      if (b.action==='heavy'){
        const now=performance.now();
        if (this._lastHeavy!=null){
          const delta=(now-this._lastHeavy)/1000;
          console.log(`%c[heavy] Δ${delta.toFixed(2)}s since your last heavy${delta<0.5?' — self-canceled into another heavy':''}`,'color:#ffb04d');
        }
        this._lastHeavy=now;
      }
      if (b.action==='grab') console.log(`%c[grab] committed — vulnerable to a strike or dodge until your own active window opens`,'color:#ff5533;font-weight:bold');
    } else if (cmd.light1 || cmd.light2 || cmd.light3 || cmd.dodge){
      // shared/movement.js checks stamina AT PRESS TIME now (against prev.stam, since
      // that's what stepBody saw before this tick's regen/spend) — insufficient stam
      // is a genuine, immediate rejection regardless of what state you're in, so it's
      // checked first. Only once stamina clears do we ask whether the start-new-action
      // gate ('none'/'block'/an attack's own cancel window — everything else has no
      // early-out at all) was actually open: if not, it's genuinely just buffered.
      if (cmd.light1 || cmd.light2 || cmd.light3){
        const which = cmd.light1 ? 'light1' : cmd.light2 ? 'light2' : 'light3', need = MOVES[which].stam;
        // Cooldown is checked first in shared/movement.js too, and per-move — a debounce
        // against keyboard auto-repeat (holding one key down) on THAT specific move, not
        // a rejection about stamina or timing, so it gets its own message. Firing light1
        // never shows up here as light2/light3's reason for not firing.
        if (prev.lightCooldownT[which] > 0)
          console.log(`%c[combat] ${which} press ignored — still on cooldown (${prev.lightCooldownT[which].toFixed(2)}s left)`,'color:#888');
        else if (prev.stam < need){
          console.log(`%c[combat] ${which} press had no effect — stam ${b.stam.toFixed(0)}/${b.maxStam} (needs ${need})`,'color:#888');
          this.events.push({ e:'denied' });   // drained by main.js — a visual/audio "rejected" cue, not a server event
        } else
          console.log(`%c[combat] ${which} buffered — still mid-${prev.action}, fires automatically once free`,'color:#8ecbff');
      } else {
        if (prev.stam < CFG.dodgeStam){
          console.log(`%c[dodge] press had no effect — stam ${b.stam.toFixed(0)}/${b.maxStam} (needs ${CFG.dodgeStam})`,'color:#888');
          this.events.push({ e:'denied' });
        } else
          console.log(`%c[dodge] press buffered — still mid-${prev.action}, gate not open yet`,'color:#888');
      }
    // Heavy (F) tap: shared/movement.js only queues bufHeavy on RELEASE (that's the
    // moment it can tell a hold-into-grab apart from a tap), so "was it rejected for
    // stamina" has to be checked here at that same release instant — prev.heavyHoldT
    // (captured before this tick's stepBody ran) being >0 and still under the grab
    // threshold means this release WAS a genuine tap attempt, not a hold or a no-op.
    // heavyHeld itself stays otherwise unlogged while continuously held (would spam
    // the console) — this only fires once, on the exact release tick.
    } else if (!cmd.heavyHeld && prev.heavyHoldT>0 && prev.heavyHoldT<CFG.grabHoldThreshold && prev.stam<MOVES.heavy.stam){
      console.log(`%c[combat] heavy press had no effect — stam ${b.stam.toFixed(0)}/${b.maxStam} (needs ${MOVES.heavy.stam})`,'color:#888');
      this.events.push({ e:'denied' });
    // Grab: shared/movement.js retries beginAtk(b,'grab') every tick once heavyHoldT
    // crosses the threshold, for as long as F stays held and stamina stays short — it
    // doesn't reset heavyHoldT on failure (so it can fire the instant stamina clears
    // without needing a fresh hold). Logging that every tick would spam the console,
    // so this only fires once, on the exact tick heavyHoldT first crosses over.
    } else if (cmd.heavyHeld && prev.heavyHoldT<CFG.grabHoldThreshold && b.heavyHoldT>=CFG.grabHoldThreshold && prev.stam<MOVES.grab.stam){
      console.log(`%c[grab] hold threshold reached but had no effect — stam ${b.stam.toFixed(0)}/${b.maxStam} (needs ${MOVES.grab.stam})`,'color:#888');
      this.events.push({ e:'denied' });
    }
  }

  // ack arrives as its own top-level field, not nested in `s` — see server/rooms.js's
  // _broadcastSnapshot(), which pre-serializes the (identical-for-every-client) `s`
  // payload once per tick and splices in each client's own ack separately, instead of
  // re-serializing the whole snapshot per client just to vary one number.
  _snapshot(s, ack){
    this.radius = s.r; this.over = !!s.over; this.winner = s.win;
    this.countdownT = s.cd || 0;   // server-authoritative "frozen beat before battle" — see server/world.js
    this.items = s.items || []; this.orbs = s.orbs || []; this.projectiles = s.proj || [];
    for (const ev of s.ev) this.events.push(ev);

    const now = performance.now();
    const seen = new Set();
    for (const body of s.b){
      seen.add(body.id);
      if (body.id === this.selfId){
        // RECONCILE: adopt authoritative state, then replay unacknowledged inputs
        const px=this.local.x, py=this.local.y, pz=this.local.z;   // predicted position, pre-correction
        Object.assign(this.local, body); delete this.local.id;
        this.pending = this.pending.filter(p => p.seq > ack);
        for (const p of this.pending) stepBody(this.local, p.cmd, NET.FIXED_DT);
        // stash whatever this correction just moved us by (see decayPosError above)
        this.posError.x += px - this.local.x;
        this.posError.y += py - this.local.y;
        this.posError.z += pz - this.local.z;
      } else {
        // buffer remote snapshots for interpolation (timestamped on arrival)
        let buf = this.remotes.get(body.id);
        if (!buf){ buf = []; this.remotes.set(body.id, buf); }
        buf.push({ t: now, b: body });
        if (buf.length > 30) buf.shift();
      }
    }
    // drop remotes that left
    for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
  }

  // sample a remote's interpolated pose at render time
  sampleRemote(id){
    const buf = this.remotes.get(id); if (!buf || !buf.length) return null;
    if (buf.length === 1) return { ...buf[0].b, speed:0 };
    const t = performance.now() - NET.INTERP_MS;
    let i = buf.length - 1; while (i>0 && buf[i-1].t > t) i--;
    const b = buf[Math.min(i, buf.length-1)], a = buf[Math.max(i-1, 0)];
    const f = clamp((t - a.t) / Math.max(1, b.t - a.t), 0, 1);
    const x = lerp(a.b.x, b.b.x, f), y = lerp(a.b.y, b.b.y, f), z = lerp(a.b.z, b.b.z, f);
    let dr = b.b.rotY - a.b.rotY; dr = Math.atan2(Math.sin(dr), Math.cos(dr));
    const rotY = a.b.rotY + dr*f;
    const dtS = Math.max(1, b.t - a.t) / 1000;
    const speed = Math.hypot(b.b.x - a.b.x, b.b.z - a.b.z) / dtS;
    return { ...b.b, x, y, z, rotY, speed };
  }

  drainEvents(){ const e = this.events; this.events = []; return e; }

  disconnect(){ try { this.ws && this.ws.close(); } catch(e){} this.joined = false; this.status = 'left'; }
}

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
