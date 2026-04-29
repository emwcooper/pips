// Renders the puzzle grid: cells, region colors+outlines, constraint badges.
// Returns helpers for slot positioning so drag/drop can hit-test against slots.

import { el, clear } from './dom.js';
import { describeConstraint } from '../puzzle/checker.js';

const PALETTE = [
  '#ffe8c2', '#d6f0d8', '#d2e6f7', '#fadce4',
  '#eadcf5', '#fff4bc', '#d8efea', '#f7dcc7',
  '#e8e0c4', '#dde7d2', '#e9d4d2', '#d6dff5',
];

/**
 * @param {HTMLElement} container
 * @param {import('../puzzle/types.js').Puzzle} puzzle
 */
export function renderBoard(container, puzzle) {
  clear(container);
  container.style.gridTemplateColumns = `repeat(${puzzle.width}, var(--cell))`;
  container.style.gridTemplateRows = `repeat(${puzzle.height}, var(--cell))`;
  container.style.width = `calc(${puzzle.width} * var(--cell))`;
  container.style.height = `calc(${puzzle.height} * var(--cell))`;

  const W = puzzle.width;
  const H = puzzle.height;

  // Pick a color per region. To keep adjacent regions visually distinct, walk
  // regions in order and avoid reusing a neighbor's color when we can.
  const regionColors = pickRegionColors(puzzle);

  const cellEls = new Array(puzzle.cells.length);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const cellId = puzzle.cellAtRC[r * W + c];
      if (cellId < 0) {
        const blocked = el('div', { class: 'cell blocked' });
        blocked.style.gridColumn = String(c + 1);
        blocked.style.gridRow = String(r + 1);
        container.appendChild(blocked);
      } else {
        const cellRegion = puzzle.cells[cellId].region;
        const cell = el('div', { class: 'cell', data: { id: cellId, region: cellRegion } });
        cell.style.gridColumn = String(c + 1);
        cell.style.gridRow = String(r + 1);
        cell.style.background = regionColors[cellRegion];
        const overlay = el('div', { class: 'edge-overlay' });
        // For each side, determine whether the neighbor is OUTSIDE the grid
        // (off-board or blocked) vs. just a different region. Outside edges
        // are drawn thicker/darker to distinguish board boundary from region
        // borders.
        const topOutside = isOutside(puzzle, r - 1, c);
        const bottomOutside = isOutside(puzzle, r + 1, c);
        const leftOutside = isOutside(puzzle, r, c - 1);
        const rightOutside = isOutside(puzzle, r, c + 1);
        const drawTop = topOutside || differentRegion(puzzle, r - 1, c, cellRegion);
        const drawBottom = bottomOutside || differentRegion(puzzle, r + 1, c, cellRegion);
        const drawLeft = leftOutside || differentRegion(puzzle, r, c - 1, cellRegion);
        const drawRight = rightOutside || differentRegion(puzzle, r, c + 1, cellRegion);
        if (drawTop) overlay.appendChild(el('span', { class: topOutside ? 'e-top boundary' : 'e-top' }));
        if (drawRight) overlay.appendChild(el('span', { class: rightOutside ? 'e-right boundary' : 'e-right' }));
        if (drawBottom) overlay.appendChild(el('span', { class: bottomOutside ? 'e-bottom boundary' : 'e-bottom' }));
        if (drawLeft) overlay.appendChild(el('span', { class: leftOutside ? 'e-left boundary' : 'e-left' }));
        cell.appendChild(overlay);
        container.appendChild(cell);
        cellEls[cellId] = cell;
      }
    }
  }

  // Precompute geometry once; getComputedStyle is too slow for the drag hot loop.
  const cellPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 56;

  // Constraint badges anchored at the region's top-left cell corner (so a placed
  // domino, which sits in cell-center, doesn't fully cover the label). z-index
  // keeps the badge visible above dominoes.
  for (const region of puzzle.regions) {
    if (region.constraint.kind === 'blank') continue;
    const text = describeConstraint(region.constraint);
    const anchor = topLeftCell(region, puzzle);
    const label = el('div', { class: 'region-label' }, text);
    label.style.left = `${anchor.col * cellPx + 3}px`;
    label.style.top = `${anchor.row * cellPx + 2}px`;
    container.appendChild(label);
  }

  const slotRects = new Array(puzzle.slots.length);
  for (let s = 0; s < puzzle.slots.length; s++) {
    const [a, b] = puzzle.slots[s];
    const ar = puzzle.cells[a].row, ac = puzzle.cells[a].col;
    const br = puzzle.cells[b].row, bc = puzzle.cells[b].col;
    const horizontal = ar === br;
    const minR = Math.min(ar, br);
    const minC = Math.min(ac, bc);
    const w = horizontal ? 2 * cellPx : cellPx;
    const h = horizontal ? cellPx : 2 * cellPx;
    const x = minC * cellPx;
    const y = minR * cellPx;
    slotRects[s] = { x, y, w, h, horizontal, cx: x + w / 2, cy: y + h / 2 };
  }

  return {
    cellEls,
    cellPx,
    slotRect(slotIdx) { return slotRects[slotIdx]; },
    allSlotRects() { return slotRects; },
    cellRect(cellId) {
      const { row, col } = puzzle.cells[cellId];
      return { x: col * cellPx, y: row * cellPx, w: cellPx, h: cellPx };
    },
  };
}

function differentRegion(puzzle, r, c, regionId) {
  if (r < 0 || r >= puzzle.height || c < 0 || c >= puzzle.width) return true;
  const id = puzzle.cellAtRC[r * puzzle.width + c];
  if (id < 0) return true;
  return puzzle.cells[id].region !== regionId;
}

function isOutside(puzzle, r, c) {
  if (r < 0 || r >= puzzle.height || c < 0 || c >= puzzle.width) return true;
  return puzzle.cellAtRC[r * puzzle.width + c] < 0;
}

function topLeftCell(region, puzzle) {
  let bestRow = Infinity, bestCol = Infinity;
  for (const cellId of region.cells) {
    const c = puzzle.cells[cellId];
    if (c.row < bestRow || (c.row === bestRow && c.col < bestCol)) {
      bestRow = c.row; bestCol = c.col;
    }
  }
  return { row: bestRow, col: bestCol };
}

function pickRegionColors(puzzle) {
  // For each region in order, choose a palette color that doesn't match any
  // already-assigned adjacent region's color. Greedy four-color-style.
  const colors = new Array(puzzle.regions.length).fill(null);
  // Build region adjacency.
  const adj = new Map();
  for (let i = 0; i < puzzle.regions.length; i++) adj.set(i, new Set());
  for (let r = 0; r < puzzle.height; r++) {
    for (let c = 0; c < puzzle.width; c++) {
      const id = puzzle.cellAtRC[r * puzzle.width + c];
      if (id < 0) continue;
      const myReg = puzzle.cells[id].region;
      const right = c + 1 < puzzle.width ? puzzle.cellAtRC[r * puzzle.width + c + 1] : -1;
      const down = r + 1 < puzzle.height ? puzzle.cellAtRC[(r + 1) * puzzle.width + c] : -1;
      if (right >= 0) {
        const nr = puzzle.cells[right].region;
        if (nr !== myReg) { adj.get(myReg).add(nr); adj.get(nr).add(myReg); }
      }
      if (down >= 0) {
        const nr = puzzle.cells[down].region;
        if (nr !== myReg) { adj.get(myReg).add(nr); adj.get(nr).add(myReg); }
      }
    }
  }
  for (let i = 0; i < puzzle.regions.length; i++) {
    const used = new Set();
    for (const n of adj.get(i)) if (colors[n]) used.add(colors[n]);
    let pick = null;
    for (let off = 0; off < PALETTE.length; off++) {
      const c = PALETTE[(i + off) % PALETTE.length];
      if (!used.has(c)) { pick = c; break; }
    }
    if (!pick) pick = PALETTE[i % PALETTE.length];
    colors[i] = pick;
  }
  return colors;
}
