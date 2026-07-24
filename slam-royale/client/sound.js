// Small mixer: named sound-cue slots (shared/audio.js's SOUND_SLOTS), each with an
// admin-uploaded sample and an admin-tunable volume, played through a per-slot
// GainNode into one shared AudioContext. Used both in-match (actual cue playback —
// see client/net.js pushing the event, main.js draining and calling play()) and in
// the Studio (mixer preview).
import { SOUND_SLOTS } from '../shared/audio.js';
import { soundFileUrl } from './sound-sync.js';

export class SoundBank {
  constructor() {
    this.ctx = null; this.master = null;
    this.gains = {}; this.buffers = {}; this.volumes = {};
    this.active = {};   // slot -> {src,gain} of whatever instance is currently playing, if any
    // trim: slot -> {start, end} (seconds into the sample) — admin-set start/end
    // points (Studio's Audio Mixer knobs) narrowing playback down to a region of the
    // sample, independent of the `duration` param play() also accepts (that one's an
    // animation-length cutoff computed at runtime — see play()'s own comment). end:
    // null means "no end trim, play to the sample's own natural end."
    this.trims = {};
    for (const s of SOUND_SLOTS) this.volumes[s] = 1;
  }
  // Live-updates a slot's trim (Studio preview, before/without a persisted round trip
  // — same "instant preview" reasoning as loadFilePreview()). Doesn't touch anything
  // already playing; only affects the NEXT play() of this slot.
  setTrim(slot, start, end) { this.trims[slot] = { start: start||0, end: (typeof end==='number' && end>0) ? end : null }; }
  // Creating the context and decoding samples can happen anytime, but actually being
  // AUDIBLE needs a real user gesture first (browser autoplay policy) — call resume()
  // from one (e.g. main.js's click-to-lock-pointer handler, or a Studio preview click,
  // which is itself the gesture).
  ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    for (const s of SOUND_SLOTS) {
      const g = this.ctx.createGain(); g.gain.value = this.volumes[s]; g.connect(this.master); this.gains[s] = g;
    }
  }
  resume() { this.ensureContext(); if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
  setVolume(slot, v) {
    this.volumes[slot] = v;
    if (this.gains[slot]) this.gains[slot].gain.value = v;
  }
  // cfg: result of getSoundConfig() — { [slot]: { volume, hasSample, start, end } }
  async load(cfg) {
    this.ensureContext();
    for (const slot of SOUND_SLOTS) {
      const entry = cfg[slot] || {};
      this.setVolume(slot, typeof entry.volume === 'number' ? entry.volume : 1);
      this.setTrim(slot, entry.start, entry.end);
      if (!entry.hasSample) { this.buffers[slot] = null; continue; }
      try {
        const res = await fetch(soundFileUrl(slot));
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const arr = await res.arrayBuffer();
        this.buffers[slot] = await this.ctx.decodeAudioData(arr);
      } catch (e) { console.warn(`could not load sound "${slot}"`, e); this.buffers[slot] = null; }
    }
  }
  // Decode an already-picked File directly (Studio preview, before/without a server
  // round trip) — lets "choose file" → "preview" work instantly. Resets trim: old
  // start/end points were measured against whatever sample used to be in this slot
  // and have no meaningful relationship to a brand new file's own length/content
  // (matches server/db.js's upsertSoundSample doing the same reset on the persisted side).
  async loadFilePreview(slot, file) {
    this.ensureContext();
    const arr = await file.arrayBuffer();
    this.buffers[slot] = await this.ctx.decodeAudioData(arr);
    this.setTrim(slot, 0, null);
  }
  // Stops whatever instance of `slot` is still playing, if any — a short fade first
  // (same click-avoidance reasoning as the duration cutoff below), not an instant
  // stop(). Called automatically at the start of every play() of the same slot.
  _cutOff(slot) {
    const cur = this.active[slot]; if (!cur) return;
    const { src, gain } = cur;
    try {
      const now = this.ctx.currentTime, fade = 0.03;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + fade);
      src.stop(now + fade + 0.01);
    } catch (e) {}
    this.active[slot] = null;
  }
  // Public form of _cutOff() — for callers outside this class that need to end a
  // still-playing sound early (e.g. the match-end music once the player clicks past
  // the results screen, rather than letting it play out on its own into the lobby).
  stop(slot) { this._cutOff(slot); }
  // duration (optional, seconds): the corresponding animation/action's real length —
  // e.g. a move's own `dur`, a hitstun's `hit`, DEAD_DUR, CLASH_STAGGER_DUR (see the
  // call sites in client/net.js/main.js). If the (trimmed — see below) sample
  // outlasts it, the sound gets cut off at the same moment the animation does,
  // instead of playing on into whatever state comes next. Omit it (jump/land/
  // pickups/etc. — momentary dings with no animation duration to sync to) and it
  // just plays out to the end of its trim, unchanged.
  play(slot, duration) {
    if (!this.ctx || !this.buffers[slot]) return;
    this.resume();
    // Every slot is exclusive with itself: mashing an attack, or two hits landing in
    // quick succession, cuts off whatever's still playing for that SAME slot first,
    // instead of stacking overlapping copies of the identical sound on top of it.
    this._cutOff(slot);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[slot];
    // Every instance gets its own gain node — not just when `duration` is given —
    // so _cutOff() above always has something to fade against, regardless of why
    // this particular instance eventually stops (natural end, duration cutoff, or
    // getting cut off early by the next play() of the same slot).
    const gain = this.ctx.createGain();
    src.connect(gain); gain.connect(this.gains[slot]);
    const entry = { src, gain };
    this.active[slot] = entry;
    src.onended = () => { if (this.active[slot] === entry) this.active[slot] = null; };
    // Trim (admin-set start/end points, Studio's Audio Mixer knobs) narrows the
    // buffer down to the region that's ever actually played; `duration` above can cut
    // it EVEN SHORTER at runtime for animation sync, but never extends past the trim.
    const bufDur = src.buffer.duration;
    const trim = this.trims[slot];
    const tStart = trim ? Math.min(Math.max(0, trim.start||0), bufDur) : 0;
    const tEnd = trim && trim.end>tStart && trim.end<=bufDur ? trim.end : bufDur;
    const trimmedLen = tEnd - tStart;
    const playLen = (duration>0 && duration<trimmedLen) ? duration : trimmedLen;
    if (playLen < trimmedLen) {
      // A hard stop mid-waveform can click/pop, so fade the gain out over a short
      // window ending exactly at the cutoff first — the explicit duration passed to
      // start() below already stops playback there on its own, this is just to avoid
      // an audible click at that exact stop.
      const fade = Math.min(0.03, playLen * 0.3);
      const t0 = this.ctx.currentTime;
      gain.gain.setValueAtTime(1, t0);
      gain.gain.setValueAtTime(1, t0 + playLen - fade);
      gain.gain.linearRampToValueAtTime(0, t0 + playLen);
    }
    // start(when, offset, duration): offset is where in the buffer to begin (the trim
    // start), duration is how long to play from there — the node stops on its own
    // once that elapses, no separate stop() call needed.
    src.start(0, tStart, playLen);
  }
}
