// Client for the public lobby browser (GET /api/lobbies — see server/rooms.js's
// RoomManager.list()). No write route: rooms are only created/joined through the
// WebSocket JOIN message (see client/net.js's connect()), never through this REST API.

const BASE = (typeof window !== 'undefined' && window.SLAM_API_BASE) || '';

async function jsonReq(method, url) {
  const res = await fetch(BASE + url, { method, credentials: 'include' });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
  return data;
}

export const getLobbies = () => jsonReq('GET', '/api/lobbies');
