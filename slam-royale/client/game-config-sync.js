// Client for the admin-tunable match balance values (items/throw/superstar — see
// shared/constants.js's GAME_CONFIG_KEYS). Reads are public: every client must apply
// the same values before a match starts, since some feed shared/movement.js's
// stepBody(), which client and server both run. Writes are admin-only server-side.

const BASE = (typeof window !== 'undefined' && window.SLAM_API_BASE) || '';

async function jsonReq(method, url, body) {
  const opts = { method, credentials: 'include' };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export const getGameConfig = () => jsonReq('GET', '/api/game-config');
export const patchGameConfig = cfg => jsonReq('PATCH', '/api/game-config', cfg);
