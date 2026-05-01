// Pips global stats backend.
//
// Endpoints:
//   POST /solve         — record a solve  { difficulty, elapsedMs, clientId? }
//   GET  /histogram?difficulty=easy — return aggregate counts for that difficulty
//
// Storage: a single D1 table 'solves' bound as env.DB.

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const MIN_MS = 5000;        // anything under 5s is rejected as bogus
const MAX_MS = 60 * 60 * 1000; // 60 min cap; longer runs likely AFK

const BUCKETS = [
  { label: '<30s',   max: 30_000 },
  { label: '30s–1m', max: 60_000 },
  { label: '1–2m',   max: 120_000 },
  { label: '2–3m',   max: 180_000 },
  { label: '3–5m',   max: 300_000 },
  { label: '5–10m',  max: 600_000 },
  { label: '10m+',   max: Infinity },
];

// Allowed origins. Production site + a couple of dev origins so we can test
// locally without disabling CORS entirely.
const ALLOWED_ORIGINS = new Set([
  'https://emwcooper.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://emwcooper.github.io';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/solve' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return json(request, 400, { error: 'invalid json' }); }

      const { difficulty, elapsedMs, clientId } = body || {};
      if (!DIFFICULTIES.has(difficulty)) {
        return json(request, 400, { error: 'bad difficulty' });
      }
      const ms = Number(elapsedMs);
      if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
        return json(request, 400, { error: 'bad elapsedMs' });
      }
      const cid = typeof clientId === 'string' && clientId.length <= 64 ? clientId : null;

      await env.DB.prepare(
        'INSERT INTO solves (difficulty, elapsed_ms, client_id, ts) VALUES (?, ?, ?, ?)'
      ).bind(difficulty, Math.floor(ms), cid, Date.now()).run();

      return json(request, 200, { ok: true });
    }

    if (url.pathname === '/histogram' && request.method === 'GET') {
      const difficulty = url.searchParams.get('difficulty');
      if (!DIFFICULTIES.has(difficulty)) {
        return json(request, 400, { error: 'bad difficulty' });
      }
      // Aggregate in SQL: one COUNT per bucket (skipping the open-ended last bucket).
      const stmt = env.DB.prepare(`
        SELECT
          SUM(CASE WHEN elapsed_ms <  30000 THEN 1 ELSE 0 END) AS b0,
          SUM(CASE WHEN elapsed_ms >= 30000  AND elapsed_ms <  60000  THEN 1 ELSE 0 END) AS b1,
          SUM(CASE WHEN elapsed_ms >= 60000  AND elapsed_ms <  120000 THEN 1 ELSE 0 END) AS b2,
          SUM(CASE WHEN elapsed_ms >= 120000 AND elapsed_ms <  180000 THEN 1 ELSE 0 END) AS b3,
          SUM(CASE WHEN elapsed_ms >= 180000 AND elapsed_ms <  300000 THEN 1 ELSE 0 END) AS b4,
          SUM(CASE WHEN elapsed_ms >= 300000 AND elapsed_ms <  600000 THEN 1 ELSE 0 END) AS b5,
          SUM(CASE WHEN elapsed_ms >= 600000 THEN 1 ELSE 0 END) AS b6,
          COUNT(*) AS total
        FROM solves WHERE difficulty = ?
      `).bind(difficulty);
      const row = await stmt.first();
      const counts = [row?.b0 ?? 0, row?.b1 ?? 0, row?.b2 ?? 0, row?.b3 ?? 0, row?.b4 ?? 0, row?.b5 ?? 0, row?.b6 ?? 0];
      return json(request, 200, {
        difficulty,
        labels: BUCKETS.map((b) => b.label),
        counts,
        total: row?.total ?? 0,
      });
    }

    return json(request, 404, { error: 'not found' });
  },
};
