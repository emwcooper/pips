// Client-side hook to the global stats Worker.
//
// Set STATS_API_URL after deploying the Worker (printed by `wrangler deploy`).
// Leaving it empty disables global stats — the app stays purely client-side.

export const STATS_API_URL = 'https://pips-stats.binarypigeon.workers.dev';

const CLIENT_ID_KEY = 'pips.clientId.v1';

function getOrCreateClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch { return null; }
}

/**
 * Fire-and-forget POST /solve. Does NOT throw; failures are silently ignored
 * so the local UX is unaffected by network/backend issues.
 */
export function reportWinToGlobal(difficulty, elapsedMs) {
  if (!STATS_API_URL) return;
  const body = JSON.stringify({ difficulty, elapsedMs, clientId: getOrCreateClientId() });
  // keepalive lets the request survive a page navigation if the user immediately
  // clicks New Puzzle (or closes the tab) right after solving.
  fetch(STATS_API_URL + '/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

/**
 * GET /histogram. Returns null on any error so the caller can render
 * the local-only stats panel without the global section.
 */
export async function fetchGlobalHistogram(difficulty) {
  if (!STATS_API_URL) return null;
  try {
    const r = await fetch(`${STATS_API_URL}/histogram?difficulty=${encodeURIComponent(difficulty)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
