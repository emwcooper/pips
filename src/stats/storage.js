// Persistence in localStorage: stats and the user's difficulty preference.

const KEY = 'pips.stats.v1';
const DIFFICULTY_KEY = 'pips.difficulty.v1';

export function loadDifficulty() {
  try {
    const v = localStorage.getItem(DIFFICULTY_KEY);
    if (v === 'easy' || v === 'medium' || v === 'hard' || v === 'logic') return v;
  } catch (_) {}
  return 'easy';
}

export function saveDifficulty(level) {
  try { localStorage.setItem(DIFFICULTY_KEY, level); } catch (_) {}
}

const DEFAULT = {
  wins: 0,
  giveUps: 0,
  fastestMs: null,
  winTimesMs: [],
};

export function loadStats() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT, ...parsed };
  } catch (_) {
    return { ...DEFAULT };
  }
}

export function saveStats(stats) {
  try { localStorage.setItem(KEY, JSON.stringify(stats)); } catch (_) {}
}

export function resetStats() {
  saveStats({ ...DEFAULT });
}

export function recordWin(elapsedMs) {
  const s = loadStats();
  s.wins += 1;
  s.winTimesMs.push(elapsedMs);
  if (s.fastestMs === null || elapsedMs < s.fastestMs) s.fastestMs = elapsedMs;
  saveStats(s);
}

export function recordGiveUp() {
  const s = loadStats();
  s.giveUps += 1;
  saveStats(s);
}

export function computedStats(s = loadStats()) {
  const total = s.wins + s.giveUps;
  const winRate = total === 0 ? null : s.wins / total;
  const avg = s.winTimesMs.length ? s.winTimesMs.reduce((a, b) => a + b, 0) / s.winTimesMs.length : null;
  return { ...s, total, winRate, avgMs: avg };
}
