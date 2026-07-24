// Client for the ONE game-wide default character. Reads are public (every player's
// client needs the model/animation files to render everyone the same way); writes
// are enforced admin-only server-side (the Studio is the only caller of those).

// Empty by default (bare relative '/api/...', matching a standalone Slam Royale
// deploy where the page and API share an origin). When embedded inside another
// site (e.g. served from GitHub Pages while the API runs on Railway), that page
// sets window.SLAM_API_BASE to the API's origin + mount path (e.g.
// 'https://your-app.up.railway.app/slam-royale') before this file loads — same
// convention as this project's own SITE_API_BASE.
const BASE = (typeof window !== 'undefined' && window.SLAM_API_BASE) || '';

async function jsonReq(method, url, body) {
  // 'include' (not 'same-origin'): once BASE points at a different origin than the
  // page itself, 'same-origin' would silently drop the session cookie and every
  // admin-only request would 401 — 'include' still behaves identically for the
  // standalone same-origin case, so this is safe either way.
  const opts = { method, credentials: 'include' };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export const getDefaultCharacter = () => jsonReq('GET', '/api/default-character');
export const patchSettings = settings => jsonReq('PATCH', '/api/default-character/settings', settings);
export const deleteCharacter = () => jsonReq('DELETE', '/api/default-character');
export const deleteModel = () => jsonReq('DELETE', '/api/default-character/model');
export const useSample = settings => jsonReq('POST', '/api/default-character/sample', { settings });

async function upload(url, file, settings) {
  const fd = new FormData();
  fd.append('settings', JSON.stringify(settings));
  fd.append('file', file, file.name);
  const res = await fetch(BASE + url, { method: 'POST', credentials: 'include', body: fd });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `upload failed (${res.status})`);
  return data;
}
export const uploadModel = (file, settings) => upload('/api/default-character/model', file, settings);
export const uploadAnim = (file, settings) => upload('/api/default-character/anim', file, settings);

async function fetchBlob(url, fallbackName) {
  const res = await fetch(BASE + url, { credentials: 'include' });
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const m = /filename="([^"]*)"/.exec(disp);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  return new File([blob], name, { type: blob.type });
}
export const getModelFile = () => fetchBlob('/api/default-character/model-file', 'model');
export const getAnimFile = name => fetchBlob(`/api/default-character/anim-file?name=${encodeURIComponent(name)}`, name);
