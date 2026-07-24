// Password hashing (scrypt, built into Node — no extra dependency) and cookie-based
// sessions. A session is just a random token in a DB table pointing at a user id;
// the cookie carries only the token, never the password or user id directly.

import crypto from 'crypto';
import { stmt } from './db.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'sid';

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve(derived));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt)).toString('hex');
  return { hash, salt };
}

export async function verifyPassword(password, hash, salt) {
  const derived = await scrypt(password, salt);
  const stored = Buffer.from(hash, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
export function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmt.createSession.run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function destroySession(token) {
  if (token) stmt.deleteSession.run(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolves the logged-in user (or null) from the request's session cookie.
export function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = stmt.sessionByToken.get(token);
  if (!session || session.expires_at < Date.now()) return null;
  const user = stmt.userById.get(session.user_id);
  return user ? { ...user, sessionToken: token } : null;
}

// SameSite=Lax cookies are never sent on cross-site fetch()/XHR requests (only
// on top-level navigations) — only SameSite=None does that, and browsers only
// accept SameSite=None alongside Secure. Since this app is now served from a
// different origin than its own API (GitHub Pages ↔ Railway — see
// client/character-sync.js's SLAM_API_BASE), every request is cross-site, so
// Lax would silently never send the session cookie back after login, making
// every admin-only request 401 regardless of actually being logged in. `secure`
// already reflects whether THIS request is actually HTTPS (api.js's isSecure())
// — None+Secure whenever it is (production, behind Railway's TLS), falling back
// to the old Lax (no Secure) for plain-http local dev, where SameSite=None
// would be rejected by the browser outright and no cookie would be set at all.
export function sessionCookie(token, secure) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const sameSite = secure ? 'None; Secure' : 'Lax';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=${sameSite}`;
}
export function clearCookie(secure) {
  const sameSite = secure ? 'None; Secure' : 'Lax';
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=${sameSite}`;
}
