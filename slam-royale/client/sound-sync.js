// Client for the admin-tunable sound mixer (shared/audio.js's SOUND_SLOTS). Reads are
// public: every client needs the volume + sample to actually play a cue. Writes
// (volume + sample upload/clear) are admin-only server-side.

const BASE = (typeof window !== 'undefined' && window.SLAM_API_BASE) || '';

async function jsonReq(method, url, body) {
  const opts = { method, credentials: 'include' };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export const getSoundConfig = () => jsonReq('GET', '/api/sound-config');
export const patchSoundConfig = cfg => jsonReq('PATCH', '/api/sound-config', cfg);
export const soundFileUrl = slot => `${BASE}/api/sound-file?slot=${encodeURIComponent(slot)}`;

export async function uploadSoundSample(slot, file) {
  const fd = new FormData(); fd.append('slot', slot); fd.append('file', file);
  const res = await fetch(BASE + '/api/sound-sample', { method: 'POST', credentials: 'include', body: fd });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export async function deleteSoundSample(slot) {
  const res = await fetch(`${BASE}/api/sound-sample?slot=${encodeURIComponent(slot)}`, { method: 'DELETE', credentials: 'include' });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}
