// Persistence in localStorage: stats and the user's difficulty preference.

const KEY = 'pips.stats.v2';
const OLD_KEY = 'pips.stats.v1';
const DIFFICULTY_KEY = 'pips.difficulty.v1';

const DIFFICULTIES = ['easy', 'medium', 'hard'];

export function loadDifficulty() {
  try {
    const v = localStorage.getItem(DIFFICULTY_KEY);
    if (v === 'easy' || v === 'medium' || v === 'hard') return v;
  } catch (_) {}
  return 'easy';
}

export function saveDifficulty(level) {
  try { localStorage.setItem(DIFFICULTY_KEY, level); } catch (_) {}
}

const PER_DIFF_DEFAULT = {
  wins: 0,
  giveUps: 0,
  fastestMs: null,
  winTimesMs: [],
};

function emptyStats() {
  return {
    easy: { ...PER_DIFF_DEFAULT, winTimesMs: [] },
    medium: { ...PER_DIFF_DEFAULT, winTimesMs: [] },
    hard: { ...PER_DIFF_DEFAULT, winTimesMs: [] },
  };
}

export function loadStats() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const out = emptyStats();
      for (const d of DIFFICULTIES) {
        if (parsed[d]) Object.assign(out[d], parsed[d]);
      }
      return out;
    }
    // Migrate v1 (flat) → v2 (per-difficulty). Bucket old totals under whatever
    // difficulty the user was last on, so existing players don't appear to lose stats.
    const oldRaw = localStorage.getItem(OLD_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      const out = emptyStats();
      const bucket = loadDifficulty();
      Object.assign(out[bucket], old);
      saveStats(out);
      try { localStorage.removeItem(OLD_KEY); } catch (_) {}
      return out;
    }
  } catch (_) {}
  return emptyStats();
}

export function saveStats(stats) {
  try { localStorage.setItem(KEY, JSON.stringify(stats)); } catch (_) {}
}

export function resetStats() {
  saveStats(emptyStats());
}

export function recordWin(elapsedMs, difficulty) {
  const all = loadStats();
  const s = all[difficulty];
  if (!s) return { isNewFastest: false, wasFirst: false, percentile: 0, totalWins: 0 };
  const prevTimes = s.winTimesMs.slice();
  const wasFirst = prevTimes.length === 0;
  const isNewFastest = wasFirst || elapsedMs < s.fastestMs;
  s.wins += 1;
  s.winTimesMs.push(elapsedMs);
  if (isNewFastest) s.fastestMs = elapsedMs;
  saveStats(all);
  const totalWins = prevTimes.length + 1;
  const beats = prevTimes.filter((t) => t > elapsedMs).length;
  // "+1" includes yourself: fastest of N → 100, slowest of N → 100/N (not 0).
  const percentile = Math.ceil((100 * (beats + 1)) / totalWins);
  return { isNewFastest, wasFirst, percentile, totalWins };
}

export function recordGiveUp(difficulty) {
  const all = loadStats();
  const s = all[difficulty];
  if (!s) return;
  s.giveUps += 1;
  saveStats(all);
}

export function computedStats(difficulty) {
  const s = loadStats()[difficulty];
  const total = s.wins + s.giveUps;
  const winRate = total === 0 ? null : s.wins / total;
  const avg = s.winTimesMs.length ? s.winTimesMs.reduce((a, b) => a + b, 0) / s.winTimesMs.length : null;
  return { ...s, total, winRate, avgMs: avg };
}
