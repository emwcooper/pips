// Pip dot patterns for domino faces (values 0..6).
// Each pattern is a list of (col, row) positions in a 3x3 grid (1-indexed).

const PATTERNS = {
  0: [],
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

import { el } from './dom.js';

export function pipsForValue(value) {
  const positions = PATTERNS[value] ?? [];
  const dots = [];
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      const has = positions.some(([c, r]) => c === col && r === row);
      dots.push(el('div', has ? { class: 'pip' } : { class: 'pip-empty' }));
    }
  }
  return dots;
}
