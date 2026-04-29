// Domino encoding and helpers.
// A domino is an unordered pair (a, b) with each value in 0..6.
// We encode (a, b) as key = min*7 + max, range 0..48 (with gaps; we waste ~21 slots).

export const MAX_PIP = 6;
export const NUM_KEYS = 49; // 0..48 inclusive

export function dominoKey(a, b) {
  return a <= b ? a * 7 + b : b * 7 + a;
}

export function decodeKey(key) {
  return [Math.floor(key / 7), key % 7];
}

export function isValidKey(key) {
  const a = Math.floor(key / 7);
  const b = key % 7;
  return a <= b;
}

export function allDominoKeys() {
  const out = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      out.push(a * 7 + b);
    }
  }
  return out;
}
