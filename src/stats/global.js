// Client-side hook to the global stats Worker.
//
// Set STATS_API_URL after deploying the Worker (printed by `wrangler deploy`).
// Leaving it empty disables global stats — the app stays purely client-side.

import { getPendingGlobalSync, bumpGlobalSyncedCount } from './storage.js';

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

async function postSolve(difficulty, elapsedMs) {
  if (!STATS_API_URL) return false;
  // The worker rejects solves under 5s; skip the request so we don't churn.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 5000) return false;
  try {
    const r = await fetch(STATS_API_URL + '/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty, elapsedMs, clientId: getOrCreateClientId() }),
      keepalive: true,
    });
    return r.ok;
  } catch { return false; }
}

/**
 * Fire-and-forget POST /solve for a brand-new win. On success, bumps the
 * per-difficulty synced count so we don't re-send it from the catch-up loop.
 * Failures are silent — the next page load's flushPendingGlobalSync will retry.
 */
export function reportWinToGlobal(difficulty, elapsedMs) {
  postSolve(difficulty, elapsedMs).then((ok) => {
    if (ok) bumpGlobalSyncedCount(difficulty, 1);
  });
}

/**
 * Catch-up sync on app load: for each difficulty, POST any local wins that
 * haven't yet made it to the global backend (e.g. earned before this feature
 * shipped, or while offline). Stops early on the first failure of a run so
 * we don't hammer the server when it's down — the next session retries.
 */
export async function flushPendingGlobalSync() {
  if (!STATS_API_URL) return;
  for (const diff of ['easy', 'medium', 'hard']) {
    const pending = getPendingGlobalSync(diff);
    for (const ms of pending) {
      const ok = await postSolve(diff, ms);
      if (!ok) break;
      bumpGlobalSyncedCount(diff, 1);
    }
  }
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
