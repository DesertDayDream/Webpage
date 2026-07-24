// Thin fetch wrappers over /api/* auth routes. The session lives in an HttpOnly
// cookie the browser manages automatically — this module never touches a token.

const BASE = (typeof window !== 'undefined' && window.SLAM_API_BASE) || '';

async function req(method, url, body) {
  const opts = { method, credentials: 'include' };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export const me = () => req('GET', '/api/me');
export const signup = (email, password) => req('POST', '/api/signup', { email, password });
export const login = (email, password) => req('POST', '/api/login', { email, password });
export const logout = () => req('POST', '/api/logout');
