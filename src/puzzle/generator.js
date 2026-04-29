// Puzzle generator. Strategy:
//  Phase A — sample structure (grid, irregular shape, tiling, region partition,
//            cell values, bag with unique dominoes).
//  Phase B — build puzzle with max-tight per-region constraints; if not uniquely
//            solvable, fall back to per-cell singleton-each constraints.
//  Phase C — refine: greedily merge adjacent regions, then weaken constraints.
//            Each candidate change is kept iff verify(puzzle) still holds.
//  Phase D — diversity guard.
//
// `verify` is a callback (default: brute-force "unique solution"; can be swapped
// for bounded-lookahead linear-solvability).

import { solveBounded, bruteForceCount } from './solver.js';
import { decodeKey, allDominoKeys } from './domino.js';

const SHAPES_BY_DIFFICULTY = {
  // All difficulties now use linear-solvable verification ("Logic mode" of
  // the original design); Easy/Medium/Hard differ in grid size, singleton
  // bias, and refinement aggressiveness.
  easy:   [[4, 4], [4, 5], [5, 4], [5, 5], [3, 6], [6, 3], [3, 5], [5, 3]],
  medium: [[5, 5], [5, 6], [6, 5], [6, 6], [4, 6], [6, 4]],
  hard:   [[5, 6], [6, 5], [6, 6], [6, 7], [7, 6], [4, 7], [7, 4]],
};

// Cap repeats in the bag. With multiplicity=1, the tiling is unique given values
// (which is what we need for the singleton-each starting puzzle to actually solve).
const MAX_BAG_MULTIPLICITY = 1;

/**
 * @param {() => number} [rng]
 * @param {{
 *   maxAttempts?: number,
 *   verifier?: 'unique' | 'lookahead',
 *   lookaheadDepth?: number,
 *   refine?: boolean,
 *   difficulty?: 'easy' | 'medium' | 'hard',
 *   diag?: object,
 * }} [opts]
 * @returns {{puzzle: import('./types.js').Puzzle, attempts: number, durationMs: number}}
 */
export function generatePuzzle(rng = Math.random, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const maxAttempts = opts.maxAttempts ?? 60;
  const refine = opts.refine ?? true;
  const difficulty = opts.difficulty ?? 'easy';
  // Difficulty parameters:
  //   singletonBias  — fraction of seeded regions targeted at size 1.
  //   preferSum      — when weakening, try sum candidates before lt/gt.
  // Difficulty parameters:
  //   singletonBias   — fraction of seeded regions targeted at size 1.
  //   preferSum       — when weakening, try sum candidates first.
  //   removeFraction  — max fraction of bounding-box cells removed (smaller
  //                     puzzles are easier).
  // All difficulties use the linear-solvability verifier (forward propagation
  // to fixed point, no guessing). Easy/Medium/Hard tune complexity through
  // grid size, singleton bias, and refinement settings.
  const diffSettings = {
    easy:   { singletonBias: 0.65, preferSum: true,  removeFraction: 0.62, shapes: SHAPES_BY_DIFFICULTY.easy,   disableMerge: true,  disableWeaken: false, verifier: 'linear' },
    medium: { singletonBias: 0.35, preferSum: false, removeFraction: 0.52, shapes: SHAPES_BY_DIFFICULTY.medium, disableMerge: false, disableWeaken: false, verifier: 'linear' },
    hard:   { singletonBias: 0.15, preferSum: false, removeFraction: 0.42, shapes: SHAPES_BY_DIFFICULTY.hard,   disableMerge: false, disableWeaken: false, verifier: 'linear' },
  }[difficulty] || { singletonBias: 0.35, preferSum: false, removeFraction: 0.52, shapes: SHAPES_BY_DIFFICULTY.medium, disableMerge: false, disableWeaken: false, verifier: 'linear' };
  // Default verifier: brute-force "exactly one solution". Generation is slow
  // (hundreds of ms to tens of seconds per puzzle) but produces well-defined
  // puzzles regardless of difficulty class. The worker maintains a background
  // queue so the user sees instant new puzzles after the first.
  const verifier = opts.verifier ?? 'unique';
  const depth = opts.lookaheadDepth ?? 1;
  const diag = opts.diag || { structureNull: 0, verifyFail: 0, diversityFail: 0 };

  // The diffSettings can override the verifier choice.
  const effectiveVerifier = diffSettings.verifier || verifier;
  const verify = (puzzle) => {
    if (effectiveVerifier === 'linear') {
      // Pure forward propagation only — no case-splitting allowed.
      return solveBounded(puzzle, 0).status === 'solved';
    }
    if (effectiveVerifier === 'lookahead') {
      return solveBounded(puzzle, depth).status === 'solved';
    }
    const sols = bruteForceCount(puzzle, 2);
    return sols.length === 1;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const struct = sampleStructure(rng, diffSettings);
    if (!struct) { diag.structureNull++; continue; }

    // Build with max-tight per-region constraints. The construction is from a known
    // solution, so this is one valid solution. Brute force confirms it's the only one.
    let puzzle = buildPuzzle(struct, true);
    if (!verify(puzzle)) {
      // Fallback: singleton-each pins every cell. Bag has unique dominoes, so the
      // tiling-and-values are uniquely determined.
      puzzle = buildPuzzleSingleton(struct);
      if (!verify(puzzle)) { diag.verifyFail++; continue; }
    }

    // Phase C — optional refinement (off by default; expensive when verify is brute-force).
    if (refine) refineRegions(puzzle, rng, verify, diffSettings);

    // Diversity guard removed: uniqueness is the only quality bar now.

    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    return { puzzle, attempts: attempt, durationMs: t1 - t0, diag };
  }
  const e = new Error(
    `Generator budget exhausted (${maxAttempts}). Diag: ` + JSON.stringify(diag)
  );
  e.diag = diag;
  throw e;
}

// ---------------------------------------------------------------------------
// Phase A: structure sampling
// ---------------------------------------------------------------------------

function sampleStructure(rng, diffSettings) {
  const shapes = (diffSettings && diffSettings.shapes) || SHAPES_BY_DIFFICULTY.medium;
  const [W, H] = shapes[Math.floor(rng() * shapes.length)];

  // Cell mask. Optionally remove some cells from the bounding box for irregular shape.
  let mask = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    mask = randomShapeMask(W, H, rng, diffSettings ? diffSettings.removeFraction : 0.25);
    if (mask) break;
  }
  if (!mask) return null;

  // Build cell list and lookup.
  const cellAtRC = new Int32Array(W * H);
  cellAtRC.fill(-1);
  const cells = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (mask[r * W + c]) {
        cellAtRC[r * W + c] = cells.length;
        cells.push({ row: r, col: c, region: -1 });
      }
    }
  }
  if (cells.length < 8 || cells.length % 2 !== 0) return null;

  // Adjacency (right + down per cell).
  const slots = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const id = cellAtRC[r * W + c];
      if (id < 0) continue;
      if (c + 1 < W && cellAtRC[r * W + c + 1] >= 0) slots.push([id, cellAtRC[r * W + c + 1]]);
      if (r + 1 < H && cellAtRC[(r + 1) * W + c] >= 0) slots.push([id, cellAtRC[(r + 1) * W + c]]);
    }
  }

  // Sample a random domino tiling.
  const tiling = randomTiling(cells.length, slots, rng);
  if (!tiling) return null;

  // Sample bag without replacement: shuffle the 28 unique dominoes and take
  // tiling.length of them. This guarantees unique-domino bags, which makes the
  // tiling unambiguous given pinned cell values.
  if (tiling.length > 28) return null; // too big for unique-domino sampling
  const allKeys = allDominoKeys();
  shuffle(allKeys, rng);
  const cellValue = new Uint8Array(cells.length);
  const bag = new Array(49).fill(0);
  for (let i = 0; i < tiling.length; i++) {
    const slotIdx = tiling[i];
    const [a, b] = slots[slotIdx];
    const k = allKeys[i];
    const [x, y] = decodeKey(k);
    bag[k] = 1;
    if (rng() < 0.5) { cellValue[a] = x; cellValue[b] = y; }
    else { cellValue[a] = y; cellValue[b] = x; }
  }

  // Sample a region partition by random flood-fill.
  const regionAssignment = growRegions(cells, cellAtRC, W, H, rng, diffSettings);
  if (!regionAssignment) return null;

  return {
    W, H, mask, cellAtRC, cells, slots,
    tilingSlotIds: tiling,
    cellValue, bag, regionAssignment,
  };
}

function randomShapeMask(W, H, rng, removeFraction = 0.25) {
  // 0–removeFraction of cells removed; result must be connected, even cell
  // count, and bipartite-balanced (so it can be tiled by dominoes).
  // Cells are removed in small contiguous clusters (1–4 cells per cluster)
  // so the resulting silhouette has chunky notches and irregular outlines
  // instead of scattered single-cell holes.
  const total = W * H;
  let removeCount = Math.floor(rng() * (total * removeFraction + 1));
  if (total % 2 !== 0 && removeCount === 0) removeCount = 1;
  const mask = new Uint8Array(total);
  mask.fill(1);
  const removed = new Set();
  let removedSoFar = 0;
  let attempts = 0;
  while (removedSoFar < removeCount && attempts++ < 200) {
    const r = Math.floor(rng() * H);
    const c = Math.floor(rng() * W);
    const seedIdx = r * W + c;
    if (!mask[seedIdx]) continue;
    // Cluster size: 1–6 cells, modestly biased toward smaller. Bigger
    // clusters carve out chunkier gaps in the silhouette.
    const clusterMax = Math.min(removeCount - removedSoFar, 1 + Math.floor(Math.pow(rng(), 1.3) * 6));
    const stack = [seedIdx];
    let clusterCount = 0;
    while (stack.length && clusterCount < clusterMax) {
      const idx = stack.pop();
      if (!mask[idx]) continue;
      mask[idx] = 0;
      removed.add(idx);
      clusterCount++;
      removedSoFar++;
      const cr = Math.floor(idx / W), cc = idx % W;
      const neighbors = [];
      if (cr > 0) neighbors.push(idx - W);
      if (cr < H - 1) neighbors.push(idx + W);
      if (cc > 0) neighbors.push(idx - 1);
      if (cc < W - 1) neighbors.push(idx + 1);
      shuffle(neighbors, rng);
      for (const n of neighbors) if (mask[n]) stack.push(n);
    }
  }
  // Even count check.
  let count = 0;
  for (let i = 0; i < total; i++) count += mask[i];
  if (count % 2 !== 0) {
    // Restore one removed cell.
    const it = removed.values().next();
    if (!it.done) { mask[it.value] = 1; count++; }
    else return null;
  }
  if (count < 8) return null;
  // Connectivity check (4-conn) on mask=1 cells.
  if (!isConnected(mask, W, H)) return null;
  // Bipartite balance check: dominos always cover one black + one white square
  // on a checkerboard coloring, so any tileable shape must have equal counts.
  let color0 = 0, color1 = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (mask[r * W + c]) {
        if (((r + c) & 1) === 0) color0++; else color1++;
      }
    }
  }
  if (color0 !== color1) return null;
  return mask;
}

function isConnected(mask, W, H) {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return false;
  const visited = new Uint8Array(mask.length);
  const stack = [start];
  visited[start] = 1;
  let count = 0;
  while (stack.length) {
    const idx = stack.pop();
    count++;
    const r = Math.floor(idx / W), c = idx % W;
    if (r > 0 && mask[idx - W] && !visited[idx - W]) { visited[idx - W] = 1; stack.push(idx - W); }
    if (r < H - 1 && mask[idx + W] && !visited[idx + W]) { visited[idx + W] = 1; stack.push(idx + W); }
    if (c > 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack.push(idx - 1); }
    if (c < W - 1 && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack.push(idx + 1); }
  }
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i];
  return count === total;
}

function randomTiling(N, slots, rng) {
  // Greedy random matching with restart-on-failure.
  const cellSlots = new Array(N);
  for (let i = 0; i < N; i++) cellSlots[i] = [];
  for (let s = 0; s < slots.length; s++) {
    cellSlots[slots[s][0]].push(s);
    cellSlots[slots[s][1]].push(s);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const covered = new Uint8Array(N);
    const used = [];
    let ok = true;
    // Iterate cells in random order; for each uncovered, pick a random uncovered neighbor slot.
    const order = Array.from({ length: N }, (_, i) => i);
    shuffle(order, rng);
    for (const c of order) {
      if (covered[c]) continue;
      // Find candidate slots.
      const cands = cellSlots[c].filter((s) => {
        const [a, b] = slots[s];
        return !covered[a] && !covered[b];
      });
      if (cands.length === 0) { ok = false; break; }
      const pick = cands[Math.floor(rng() * cands.length)];
      const [a, b] = slots[pick];
      covered[a] = 1; covered[b] = 1; used.push(pick);
    }
    if (ok) return used;
  }
  return null;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function growRegions(cells, cellAtRC, W, H, rng, diffSettings) {
  const N = cells.length;
  const region = new Int32Array(N);
  region.fill(-1);

  // Random target sizes — singleton bias depends on difficulty.
  const sb = diffSettings ? diffSettings.singletonBias : 0.40;
  const remaining = 1 - sb;
  const t1 = sb;
  const t2 = t1 + remaining * 0.50;
  const t3 = t2 + remaining * 0.30;
  const t4 = t3 + remaining * 0.15;
  function pickTargetSize() {
    const r = rng();
    if (r < t1) return 1;
    if (r < t2) return 2;
    if (r < t3) return 3;
    if (r < t4) return 4;
    return 5;
  }

  function neighbors(cellId) {
    const { row, col } = cells[cellId];
    const out = [];
    if (col > 0) {
      const n = cellAtRC[row * W + (col - 1)];
      if (n >= 0) out.push(n);
    }
    if (col < W - 1) {
      const n = cellAtRC[row * W + (col + 1)];
      if (n >= 0) out.push(n);
    }
    if (row > 0) {
      const n = cellAtRC[(row - 1) * W + col];
      if (n >= 0) out.push(n);
    }
    if (row < H - 1) {
      const n = cellAtRC[(row + 1) * W + col];
      if (n >= 0) out.push(n);
    }
    return out;
  }

  let regionId = 0;
  const order = Array.from({ length: N }, (_, i) => i);
  shuffle(order, rng);
  for (const seed of order) {
    if (region[seed] >= 0) continue;
    const target = pickTargetSize();
    region[seed] = regionId;
    const frontier = neighbors(seed).filter((n) => region[n] < 0);
    let size = 1;
    while (size < target && frontier.length) {
      const idx = Math.floor(rng() * frontier.length);
      const next = frontier.splice(idx, 1)[0];
      if (region[next] >= 0) continue;
      region[next] = regionId;
      size++;
      for (const nn of neighbors(next)) {
        if (region[nn] < 0 && !frontier.includes(nn)) frontier.push(nn);
      }
    }
    regionId++;
  }

  for (let c = 0; c < N; c++) cells[c].region = region[c];
  return { region, count: regionId };
}

// ---------------------------------------------------------------------------
// Phase B: build a Puzzle.
// ---------------------------------------------------------------------------

function buildPuzzle(struct, tightConstraints) {
  const { W, H, cellAtRC, cells, slots, cellValue, bag, regionAssignment, tilingSlotIds } = struct;

  const regionCells = [];
  for (let i = 0; i < regionAssignment.count; i++) regionCells.push([]);
  for (let c = 0; c < cells.length; c++) regionCells[regionAssignment.region[c]].push(c);

  const regions = regionCells.map((cellIds, id) => {
    const constraint = tightConstraints
      ? tightestConstraintForCells(cellIds, cellValue)
      : { kind: 'blank' };
    return { id, cells: cellIds, constraint };
  });

  for (let i = 0; i < cells.length; i++) cells[i].region = regionAssignment.region[i];
  const slotPairs = tilingSlotIds.map((s) => /** @type {[number,number]} */ ([slots[s][0], slots[s][1]]));

  return {
    width: W,
    height: H,
    cells,
    cellAtRC,
    slots,
    regions,
    bag,
    solution: { cellValue, slotPairs },
  };
}

/**
 * Build a Puzzle whose regions are all single-cell, each pinned to that cell's
 * solution value via an `each:value` constraint. Trivially solvable; used as
 * a fallback when the natural-region build doesn't verify.
 */
function buildPuzzleSingleton(struct) {
  const { W, H, cellAtRC, cells, slots, cellValue, bag, tilingSlotIds } = struct;

  for (let c = 0; c < cells.length; c++) cells[c].region = c;
  const regions = cells.map((_, i) => ({
    id: i,
    cells: [i],
    constraint: { kind: 'sum', n: cellValue[i] },
  }));
  const slotPairs = tilingSlotIds.map((s) => /** @type {[number,number]} */ ([slots[s][0], slots[s][1]]));

  return {
    width: W,
    height: H,
    cells,
    cellAtRC,
    slots,
    regions,
    bag,
    solution: { cellValue, slotPairs },
  };
}

/**
 * Strongest constraint that this region's solution values satisfy.
 * Lattice (strongest first): sum (single-cell pin) → eq → neq → sum → lt/gt → blank.
 *  - For a single-cell region, sum=value pins the cell.
 *  - For multi-cell all-equal, 'eq' enforces equality.
 *  - 'neq' is only valid when all values are distinct.
 *  - 'sum' always valid; expressivity varies.
 */
function tightestConstraintForCells(cellIds, cellValue) {
  if (cellIds.length === 0) return { kind: 'blank' };
  const vals = cellIds.map((c) => cellValue[c]);
  if (cellIds.length === 1) return { kind: 'sum', n: vals[0] };
  const allEqual = vals.every((v) => v === vals[0]);
  if (allEqual) return { kind: 'eq' };
  const allDistinct = new Set(vals).size === vals.length;
  if (allDistinct) return { kind: 'neq' };
  return { kind: 'sum', n: vals.reduce((s, v) => s + v, 0) };
}

// ---------------------------------------------------------------------------
// Phase C: merge + weaken. Each step must preserve linear solvability.
// ---------------------------------------------------------------------------

function refineRegions(puzzle, rng, verify, diffSettings) {
  const maxRegionSize = 5;
  const MAX_MERGE_PASSES = 8;
  const MAX_WEAKEN_PASSES = 3;
  const preferSum = diffSettings ? diffSettings.preferSum : false;
  const disableMerge = diffSettings ? diffSettings.disableMerge : false;
  const disableWeaken = diffSettings ? diffSettings.disableWeaken : false;

  // Pass 1: greedy region-merging — at most one successful merge per outer pass.
  // Skipped entirely on Easy difficulty so regions stay small.
  for (let pass = 0; !disableMerge && pass < MAX_MERGE_PASSES; pass++) {
    const adjacents = adjacentRegionPairs(puzzle);
    shuffle(adjacents, rng);
    let merged = false;
    for (const [r1, r2] of adjacents) {
      const reg1 = puzzle.regions[r1];
      const reg2 = puzzle.regions[r2];
      if (!reg1 || !reg2) continue;
      if (reg1.cells.length + reg2.cells.length > maxRegionSize) continue;
      const saved = saveRegions(puzzle);
      const mergedCells = reg1.cells.concat(reg2.cells);
      reg1.cells = mergedCells;
      reg1.constraint = tightestConstraintForCells(mergedCells, puzzle.solution.cellValue);
      puzzle.regions[r2] = null;
      for (const c of mergedCells) puzzle.cells[c].region = reg1.id;
      const beforeRegions = puzzle.regions;
      puzzle.regions = puzzle.regions.filter((r) => r != null);
      const ok = verify(puzzle);
      puzzle.regions = beforeRegions;
      if (ok) {
        compactRegions(puzzle);
        merged = true;
        break;
      } else {
        restoreRegions(puzzle, saved);
      }
    }
    if (!merged) break;
  }
  compactRegions(puzzle);

  // Pass 2: weaken constraints. Try at most 2 candidates per region per pass to
  // keep the verify-call count low. Skipped on Easy so every constraint stays
  // at its strongest form.
  for (let pass = 0; !disableWeaken && pass < MAX_WEAKEN_PASSES; pass++) {
    const order = puzzle.regions.map((_, i) => i);
    shuffle(order, rng);
    let anyChange = false;
    for (const ri of order) {
      const region = puzzle.regions[ri];
      if (!region) continue;
      let candidates = weakerCandidates(region, puzzle.solution.cellValue);
      if (preferSum) {
        // Try sum candidates first, then a couple of random others.
        const sumCands = candidates.filter((c) => c.kind === 'sum');
        const others = candidates.filter((c) => c.kind !== 'sum');
        shuffle(others, rng);
        candidates = sumCands.concat(others);
      } else {
        shuffle(candidates, rng);
      }
      const tries = candidates.slice(0, 2);
      for (const cand of tries) {
        const original = region.constraint;
        region.constraint = cand;
        if (verify(puzzle)) {
          anyChange = true;
          break;
        } else {
          region.constraint = original;
        }
      }
    }
    if (!anyChange) break;
  }
}

function adjacentRegionPairs(puzzle) {
  const seen = new Set();
  const pairs = [];
  for (const cell of puzzle.cells) {
    const myRegion = cell.region;
    const r = cell.row, c = cell.col;
    const W = puzzle.width;
    const candidates = [
      [r, c + 1], [r + 1, c],
    ];
    for (const [nr, nc] of candidates) {
      if (nc >= W || nr >= puzzle.height) continue;
      const other = puzzle.cellAtRC[nr * W + nc];
      if (other == null || other < 0) continue;
      const otherRegion = puzzle.cells[other].region;
      if (otherRegion === myRegion) continue;
      const a = Math.min(myRegion, otherRegion);
      const b = Math.max(myRegion, otherRegion);
      const key = a * 65536 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function saveRegions(puzzle) {
  return {
    regions: puzzle.regions.map((r) => r ? { id: r.id, cells: r.cells.slice(), constraint: { ...r.constraint } } : null),
    cellRegion: puzzle.cells.map((c) => c.region),
  };
}

function restoreRegions(puzzle, saved) {
  puzzle.regions = saved.regions.map((r) => r ? { id: r.id, cells: r.cells.slice(), constraint: { ...r.constraint } } : null);
  for (let i = 0; i < puzzle.cells.length; i++) puzzle.cells[i].region = saved.cellRegion[i];
}

function compactRegions(puzzle) {
  const surviving = puzzle.regions.filter((r) => r != null);
  // Reassign sequential IDs.
  const idMap = new Map();
  for (let i = 0; i < surviving.length; i++) {
    idMap.set(surviving[i].id, i);
    surviving[i].id = i;
  }
  puzzle.regions = surviving;
  for (const cell of puzzle.cells) {
    if (idMap.has(cell.region)) cell.region = idMap.get(cell.region);
  }
}


/**
 * Candidate weaker constraints (from current).
 */
function weakerCandidates(region, cellValue) {
  const c = region.constraint;
  const vals = region.cells.map((id) => cellValue[id]);
  const out = [];

  // helpers
  const pushIfValid = (cand) => {
    // Confirm cand is satisfied by the solution values.
    if (constraintSatisfied(cand, vals)) out.push(cand);
  };

  // `lt:N` and `gt:N` are sum-based: lt:N ⇔ region-sum < N, gt:N ⇔ region-sum > N.
  // Bounds:
  //   lt:N valid when S < N ≤ maxSum (and N ≥ 2 so we don't show "<1").
  //   gt:N valid when 0 ≤ N < S (so we don't show ">-1").
  const S = vals.reduce((s, v) => s + v, 0);
  const maxSum = 6 * vals.length;
  if (c.kind === 'eq') {
    pushIfValid({ kind: 'sum', n: S });
    for (let n = Math.max(2, S + 1); n <= maxSum; n++) pushIfValid({ kind: 'lt', n });
    for (let n = 0; n < S; n++) pushIfValid({ kind: 'gt', n });
    pushIfValid({ kind: 'blank' });
  } else if (c.kind === 'neq') {
    pushIfValid({ kind: 'sum', n: S });
    for (let n = Math.max(2, S + 1); n <= maxSum; n++) pushIfValid({ kind: 'lt', n });
    for (let n = 0; n < S; n++) pushIfValid({ kind: 'gt', n });
    pushIfValid({ kind: 'blank' });
  } else if (c.kind === 'sum') {
    for (let n = Math.max(2, S + 1); n <= maxSum; n++) pushIfValid({ kind: 'lt', n });
    for (let n = 0; n < S; n++) pushIfValid({ kind: 'gt', n });
    pushIfValid({ kind: 'blank' });
  } else if (c.kind === 'lt') {
    for (let n = c.n + 1; n <= maxSum; n++) pushIfValid({ kind: 'lt', n });
    pushIfValid({ kind: 'blank' });
  } else if (c.kind === 'gt') {
    for (let n = c.n - 1; n >= 0; n--) pushIfValid({ kind: 'gt', n });
    pushIfValid({ kind: 'blank' });
  }
  return out;
}

function constraintSatisfied(c, vals) {
  const sum = vals.reduce((s, v) => s + v, 0);
  switch (c.kind) {
    case 'sum': return sum === c.n;
    case 'eq': return vals.every((v) => v === vals[0]);
    case 'neq': return new Set(vals).size === vals.length;
    case 'lt': return sum < c.n;
    case 'gt': return sum > c.n;
    case 'blank': return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase D: diversity guard.
// ---------------------------------------------------------------------------

function isDiverseEnough(puzzle) {
  const counts = { sum: 0, eq: 0, neq: 0, lt: 0, gt: 0, blank: 0 };
  for (const r of puzzle.regions) counts[r.constraint.kind]++;
  const total = puzzle.regions.length;
  const blank = counts.blank;
  // Avoid puzzles that are just a single dominant constraint type.
  for (const k of Object.keys(counts)) {
    if (k === 'blank') continue;
    if (counts[k] / Math.max(1, total - blank) > 0.85 && (total - blank) >= 4) {
      return false;
    }
  }
  // Need at least *some* signal beyond blanks.
  if (total - blank < Math.max(2, Math.floor(total / 2))) return false;
  return true;
}
