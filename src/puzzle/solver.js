// Forward-deduction solver.
//
// Given a Puzzle, attempts to solve it using only constraint-propagation
// (no guessing/backtracking). Returns:
//   { status: 'solved', cellValue, placedSlots }  if every cell collapses
//   { status: 'contradiction' }                    if the rules detect inconsistency
//   { status: 'stalled' }                          if a fixed point is reached without solving
//
// "Linearly solvable" means status === 'solved'. Used during generation to
// validate that a candidate puzzle requires no guessing.

import { FULL_DOMAIN, popcount, ltMask, gtMask, has, singletonValue, lowest, highest, values as bitsetValues } from './bitset.js';

/**
 * Pure forward-deduction solver (depth = 0 lookahead).
 * @param {import('./types.js').Puzzle} puzzle
 * @returns {import('./types.js').SolverResult}
 */
export function solveLinear(puzzle) {
  return solveBounded(puzzle, 0);
}

/**
 * Solve with up to `maxDepth` levels of nested case-split lookahead.
 * - depth 0: forward propagation only.
 * - depth 1: when forward stalls, try each candidate value at one cell; if all
 *   but one branch contradict (via forward propagation), commit the survivor.
 * - depth k: same idea, with each branch evaluated using depth (k-1).
 *
 * @param {import('./types.js').Puzzle} puzzle
 * @param {number} maxDepth
 * @returns {import('./types.js').SolverResult}
 */
export function solveBounded(puzzle, maxDepth = 0) {
  const state = initSolverState(puzzle);
  applyRegionClips(state, puzzle);
  if (state.contradiction) return { status: 'contradiction' };
  for (let s = 0; s < puzzle.slots.length; s++) recomputeSlotDominoesWithSlots(state, s, puzzle.slots);
  state.dirtyCells.clear();
  state.dirtySlots.clear();
  return solveFromState(state, puzzle, maxDepth);
}

/** Run the fixed-point propagation loop on a (mutable) state. Returns 'solved' | 'stalled' | 'contradiction'. */
function runPropagation(state, puzzle) {
  let pass = 0;
  while (true) {
    if (++pass > 200) return 'stalled';
    let changed = false;
    if (regionEqRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (regionNeqRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (regionSumRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (slotDominoRebuildIfDirty(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (emptySlotRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (bagExhaustionRule(state, puzzle)) changed = true;
    if (forcedCoverRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (forcedDominoOnPlacedSlot(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (valueSupportRule(state, puzzle)) changed = true;
    if (state.contradiction) return 'contradiction';
    if (!changed) break;
  }
  return solvedStatus(state, puzzle) ? 'solved' : 'stalled';
}

function solvedStatus(state, puzzle) {
  for (let c = 0; c < puzzle.cells.length; c++) if (popcount(state.cellDomain[c]) !== 1) return false;
  for (let s = 0; s < puzzle.slots.length; s++) if (state.slotState[s] === 1) return false;
  return true;
}

function extractResult(state, puzzle) {
  const cellValue = new Uint8Array(puzzle.cells.length);
  for (let c = 0; c < puzzle.cells.length; c++) cellValue[c] = singletonValue(state.cellDomain[c]);
  const placedSlots = [];
  for (let s = 0; s < puzzle.slots.length; s++) if (state.slotState[s] === 2) placedSlots.push(s);
  return { status: 'solved', cellValue, placedSlots };
}

/** Solve with bounded lookahead, given an already-initialized state. Mutates state on success. */
function solveFromState(state, puzzle, maxDepth) {
  while (true) {
    const status = runPropagation(state, puzzle);
    if (status === 'contradiction') return { status: 'contradiction' };
    if (status === 'solved') return extractResult(state, puzzle);
    if (maxDepth <= 0) return { status: 'stalled' };

    // Pick a case-split target: cell with smallest non-singleton domain.
    let target = -1, targetSize = 8;
    for (let c = 0; c < puzzle.cells.length; c++) {
      const sz = popcount(state.cellDomain[c]);
      if (sz > 1 && sz < targetSize) { target = c; targetSize = sz; if (sz === 2) break; }
    }
    if (target < 0) return { status: 'stalled' };

    const candidates = bitsetValues(state.cellDomain[target]);
    let consistentValue = -1;
    let consistentCount = 0;
    for (const v of candidates) {
      const branch = cloneState(state);
      setCellDomain(branch, target, 1 << v);
      if (branch.contradiction) continue;
      // Recurse with one less depth — branches use only forward propagation when maxDepth-1=0.
      const r = solveFromState(branch, puzzle, maxDepth - 1);
      if (r.status !== 'contradiction') {
        consistentCount++;
        consistentValue = v;
        if (consistentCount > 1) break;
      }
    }
    if (consistentCount === 1) {
      // Commit this deduction and continue the outer loop (re-propagate).
      setCellDomain(state, target, 1 << consistentValue);
      if (state.contradiction) return { status: 'contradiction' };
    } else if (consistentCount === 0) {
      return { status: 'contradiction' };
    } else {
      return { status: 'stalled' };
    }
  }
}

/**
 * Count distinct solutions, up to `cap`. Uses constraint-propagation at every
 * level and only case-splits when propagation stalls. Far faster than naive
 * backtracking on well-formed puzzles, but the worst case is still exponential
 * in the number of slots — we apply a node budget so a single call can't hang
 * the worker. If the budget is exceeded, we conservatively return >cap "aborted"
 * sentinels so callers treat the puzzle as non-unique.
 *
 * @param {import('./types.js').Puzzle} puzzle
 * @param {number} cap
 * @param {number} nodeBudget
 */
export function countSolutions(puzzle, cap = 2, nodeBudget = 500000) {
  const state = initSolverState(puzzle);
  applyRegionClips(state, puzzle);
  if (state.contradiction) return [];
  for (let s = 0; s < puzzle.slots.length; s++) recomputeSlotDominoesWithSlots(state, s, puzzle.slots);
  state.dirtyCells.clear();
  state.dirtySlots.clear();
  const sink = [];
  const ctx = { remaining: nodeBudget, aborted: false };
  countFromState(state, puzzle, cap, sink, ctx);
  if (ctx.aborted) {
    // Conservative: report as non-unique so the caller rejects.
    return [{ aborted: true }, { aborted: true }];
  }
  return sink;
}

function countFromState(state, puzzle, cap, out, ctx) {
  if (ctx.aborted || out.length >= cap) return;
  if (--ctx.remaining <= 0) { ctx.aborted = true; return; }
  const status = runPropagation(state, puzzle);
  if (status === 'contradiction') return;
  if (status === 'solved') {
    out.push(extractResult(state, puzzle));
    return;
  }
  // Prefer case-splitting on cells (smaller branching factor than slots).
  let target = -1, targetSize = 8;
  for (let c = 0; c < puzzle.cells.length; c++) {
    const sz = popcount(state.cellDomain[c]);
    if (sz > 1 && sz < targetSize) { target = c; targetSize = sz; if (sz === 2) break; }
  }
  if (target >= 0) {
    const candidates = bitsetValues(state.cellDomain[target]);
    for (const v of candidates) {
      if (ctx.aborted || out.length >= cap) return;
      const branch = cloneState(state);
      setCellDomain(branch, target, 1 << v);
      if (branch.contradiction) continue;
      countFromState(branch, puzzle, cap, out, ctx);
    }
    return;
  }
  // All cells are singleton but propagation didn't conclude — a slot's tiling
  // is still ambiguous. Case-split on slot placement.
  let slotTarget = -1;
  for (let s = 0; s < puzzle.slots.length; s++) {
    if (state.slotState[s] === 1) { slotTarget = s; break; }
  }
  if (slotTarget < 0) return;
  {
    const branch = cloneState(state);
    placeSlot(branch, slotTarget, puzzle.slots);
    if (!branch.contradiction) countFromState(branch, puzzle, cap, out, ctx);
  }
  if (ctx.aborted || out.length >= cap) return;
  {
    const branch = cloneState(state);
    branch.slotState[slotTarget] = 0;
    branch.dirtySlots.add(slotTarget);
    countFromState(branch, puzzle, cap, out, ctx);
  }
}

function cloneState(state) {
  return {
    cellDomain: state.cellDomain.slice(),
    slotState: state.slotState.slice(),
    slotDominoes: state.slotDominoes.map((s) => new Set(s)),
    bag: state.bag.slice(),
    cellSlots: state.cellSlots, // shared (read-only)
    contradiction: state.contradiction,
    dirtyCells: new Set(state.dirtyCells),
    dirtySlots: new Set(state.dirtySlots),
    _dominoAssigned: state._dominoAssigned ? state._dominoAssigned.slice() : null,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function initSolverState(puzzle) {
  const N = puzzle.cells.length;
  const S = puzzle.slots.length;
  const cellDomain = new Uint8Array(N);
  cellDomain.fill(FULL_DOMAIN);
  const slotState = new Uint8Array(S); // 0=eliminated, 1=alive, 2=placed
  slotState.fill(1);
  /** @type {Set<DominoKey>[]} */
  const slotDominoes = new Array(S);
  for (let i = 0; i < S; i++) slotDominoes[i] = new Set();
  const bag = new Int8Array(49);
  for (let k = 0; k < 49; k++) bag[k] = puzzle.bag[k] | 0;
  // cell -> list of slots referencing this cell.
  const cellSlots = new Array(N);
  for (let i = 0; i < N; i++) cellSlots[i] = [];
  for (let s = 0; s < S; s++) {
    const [a, b] = puzzle.slots[s];
    cellSlots[a].push(s);
    cellSlots[b].push(s);
  }
  return {
    cellDomain,
    slotState,
    slotDominoes,
    bag,
    cellSlots,
    contradiction: false,
    dirtyCells: new Set(),
    dirtySlots: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCellDomain(state, c, newDomain) {
  if (state.cellDomain[c] === newDomain) return false;
  if (newDomain === 0) { state.contradiction = true; return false; }
  state.cellDomain[c] = newDomain;
  state.dirtyCells.add(c);
  for (const s of state.cellSlots[c]) state.dirtySlots.add(s);
  return true;
}

function eliminateSlot(state, s) {
  if (state.slotState[s] !== 1) return false;
  state.slotState[s] = 0;
  // Affects value support of touching cells.
  // Mark slot's cells dirty for value-support recompute via dirtySlots? simpler:
  // Just signal change; valueSupport rule will iterate over alive slots.
  state.dirtySlots.add(s);
  return true;
}

function placeSlot(state, s, slots) {
  if (state.slotState[s] === 2) return false;
  if (state.slotState[s] === 0) { state.contradiction = true; return false; }
  state.slotState[s] = 2;
  // All other alive slots touching either cell must be eliminated.
  const [a, b] = slots[s];
  for (const other of state.cellSlots[a]) {
    if (other !== s && state.slotState[other] === 1) eliminateSlot(state, other);
  }
  for (const other of state.cellSlots[b]) {
    if (other !== s && state.slotState[other] === 1) eliminateSlot(state, other);
  }
  return true;
}

function recomputeSlotDominoesWithSlots(state, slotIdx, slots) {
  if (state.slotState[slotIdx] === 0) {
    if (state.slotDominoes[slotIdx].size === 0) return false;
    state.slotDominoes[slotIdx].clear();
    return true;
  }
  const [a, b] = slots[slotIdx];
  const da = state.cellDomain[a];
  const db = state.cellDomain[b];
  const set = state.slotDominoes[slotIdx];
  let changed = false;
  // Build new set from scratch each time (cheap given small domain).
  const next = new Set();
  for (let x = 0; x <= 6; x++) {
    if (!(da & (1 << x))) continue;
    for (let y = 0; y <= 6; y++) {
      if (!(db & (1 << y))) continue;
      const k = x <= y ? x * 7 + y : y * 7 + x;
      if (state.bag[k] > 0) next.add(k);
    }
  }
  if (next.size !== set.size) changed = true;
  else { for (const k of set) if (!next.has(k)) { changed = true; break; } }
  if (changed) state.slotDominoes[slotIdx] = next;
  return changed;
}

// ---------------------------------------------------------------------------
// Region rules
// ---------------------------------------------------------------------------

function applyRegionClips(state, puzzle) {
  for (const region of puzzle.regions) {
    const c = region.constraint;
    let mask = FULL_DOMAIN;
    if (c.kind === 'lt') mask = ltMask(c.n);
    else if (c.kind === 'gt') mask = gtMask(c.n);
    if (mask === FULL_DOMAIN) continue;
    for (const cell of region.cells) {
      setCellDomain(state, cell, state.cellDomain[cell] & mask);
      if (state.contradiction) return;
    }
  }
}

function regionEqRule(state, puzzle) {
  let changed = false;
  for (const region of puzzle.regions) {
    if (region.constraint.kind !== 'eq') continue;
    let inter = FULL_DOMAIN;
    for (const c of region.cells) inter &= state.cellDomain[c];
    if (inter === 0) { state.contradiction = true; return changed; }
    for (const c of region.cells) {
      if (setCellDomain(state, c, state.cellDomain[c] & inter)) changed = true;
      if (state.contradiction) return changed;
    }
  }
  return changed;
}

function regionNeqRule(state, puzzle) {
  let changed = false;
  for (const region of puzzle.regions) {
    if (region.constraint.kind !== 'neq') continue;
    // Remove fixed values from siblings.
    for (const c of region.cells) {
      const v = singletonValue(state.cellDomain[c]);
      if (v < 0) continue;
      for (const other of region.cells) {
        if (other === c) continue;
        if (has(state.cellDomain[other], v)) {
          if (setCellDomain(state, other, state.cellDomain[other] & ~(1 << v))) changed = true;
          if (state.contradiction) return changed;
        }
      }
    }
    // Pigeon-hole: |union of domains| < |region|
    let union = 0;
    for (const c of region.cells) union |= state.cellDomain[c];
    if (popcount(union) < region.cells.length) { state.contradiction = true; return changed; }
  }
  return changed;
}

function regionSumRule(state, puzzle) {
  let changed = false;
  for (const region of puzzle.regions) {
    if (region.constraint.kind !== 'sum') continue;
    const target = region.constraint.n;
    const cells = region.cells;
    // Compute total lo and total hi.
    let totalLo = 0, totalHi = 0;
    for (const c of cells) { totalLo += lowest(state.cellDomain[c]); totalHi += highest(state.cellDomain[c]); }
    if (target < totalLo || target > totalHi) { state.contradiction = true; return changed; }
    // For each cell, prune values that can't be extended.
    for (const c of cells) {
      const dlo = lowest(state.cellDomain[c]);
      const dhi = highest(state.cellDomain[c]);
      const otherLo = totalLo - dlo;
      const otherHi = totalHi - dhi;
      let dom = state.cellDomain[c];
      for (let v = 0; v <= 6; v++) {
        if (!(dom & (1 << v))) continue;
        // Removing this cell's contribution and re-adding v:
        // others must be able to sum to target - v.
        // Min others = otherLo (if v !== dlo we don't actually replace... bounds shift).
        // Use a simpler bound: min of others alone = totalLo - dlo (cell's current min); we're testing if v is feasible.
        // Need others-sum in [target - v - 0, target - v] — actually feasibility: others-sum can range in [otherSumLo, otherSumHi] where:
        //   otherSumLo = sum over others of lowest(domain)
        //   otherSumHi = sum over others of highest(domain)
        // Since we already have totalLo and totalHi, and this cell contributes [dlo, dhi]:
        //   otherSumLo = totalLo - dlo, otherSumHi = totalHi - dhi (these are the bounds when this cell takes its lo/hi).
        // Wait: that's wrong. For others' bounds when summed independently:
        //   otherSumLo = totalLo - dlo  (true, since this cell's contribution to totalLo was dlo).
        //   otherSumHi = totalHi - dhi  (true).
        // But this cell's *actual* value is v; the others' bounds don't depend on v, they depend on others' domains.
        // So: feasibility: target - v ∈ [otherSumLo, otherSumHi] = [totalLo - dlo, totalHi - dhi].
        const need = target - v;
        if (need < (totalLo - dlo) || need > (totalHi - dhi)) {
          dom &= ~(1 << v);
        }
      }
      if (setCellDomain(state, c, dom)) changed = true;
      if (state.contradiction) return changed;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Slot / domino rules
// ---------------------------------------------------------------------------

function slotDominoRebuildIfDirty(state, puzzle) {
  let changed = false;
  if (state.dirtySlots.size === 0 && state.dirtyCells.size === 0) return false;
  const toRebuild = new Set(state.dirtySlots);
  for (const c of state.dirtyCells) for (const s of state.cellSlots[c]) toRebuild.add(s);
  state.dirtyCells.clear();
  state.dirtySlots.clear();
  for (const s of toRebuild) {
    if (recomputeSlotDominoesWithSlots(state, s, puzzle.slots)) changed = true;
  }
  return changed;
}

function emptySlotRule(state, puzzle) {
  let changed = false;
  for (let s = 0; s < puzzle.slots.length; s++) {
    if (state.slotState[s] === 1 && state.slotDominoes[s].size === 0) {
      if (eliminateSlot(state, s)) changed = true;
    }
  }
  return changed;
}

function bagExhaustionRule(state, puzzle) {
  let changed = false;
  for (let k = 0; k < 49; k++) {
    if (state.bag[k] !== 0) continue;
    for (let s = 0; s < puzzle.slots.length; s++) {
      if (state.slotDominoes[s].has(k)) {
        state.slotDominoes[s].delete(k);
        changed = true;
        state.dirtySlots.add(s); // re-evaluate downstream
      }
    }
  }
  return changed;
}

function forcedCoverRule(state, puzzle) {
  let changed = false;
  for (let c = 0; c < puzzle.cells.length; c++) {
    // Is this cell already covered by a placed slot?
    let covered = false;
    let aliveCount = 0;
    let aliveSlot = -1;
    for (const s of state.cellSlots[c]) {
      if (state.slotState[s] === 2) { covered = true; break; }
      if (state.slotState[s] === 1) { aliveCount++; aliveSlot = s; }
    }
    if (covered) continue;
    if (aliveCount === 0) { state.contradiction = true; return changed; }
    if (aliveCount === 1) {
      if (placeSlot(state, aliveSlot, puzzle.slots)) changed = true;
      if (state.contradiction) return changed;
    }
  }
  return changed;
}

function forcedDominoOnPlacedSlot(state, puzzle) {
  let changed = false;
  for (let s = 0; s < puzzle.slots.length; s++) {
    if (state.slotState[s] !== 2) continue;
    const set = state.slotDominoes[s];
    if (set.size === 0) { state.contradiction = true; return changed; }
    if (set.size !== 1) continue;
    // Determined domino. Decrement bag (only once; re-running this rule is idempotent
    // because we mark the slot as "domino-assigned" via the bag delta tracking).
    const k = set.values().next().value;
    if (state.bag[k] <= 0) { state.contradiction = true; return changed; }
    // Use a marker on slot to avoid double-decrement.
    if (!state._dominoAssigned) state._dominoAssigned = new Uint8Array(puzzle.slots.length);
    if (state._dominoAssigned[s]) {
      // Already assigned; just propagate cell domains (they may have widened? no — bitsets only narrow).
      continue;
    }
    state._dominoAssigned[s] = 1;
    state.bag[k] -= 1;
    // Set cell domains to the values of this domino.
    const x = Math.floor(k / 7);
    const y = k % 7;
    const [a, b] = puzzle.slots[s];
    // Both orientations ((a=x,b=y) or (a=y,b=x)) might still be valid. Cell domains should be the
    // intersection of "x or y" (i.e. their bit set).
    const both = (1 << x) | (1 << y);
    if (setCellDomain(state, a, state.cellDomain[a] & both)) changed = true;
    if (setCellDomain(state, b, state.cellDomain[b] & both)) changed = true;
    if (state.contradiction) return changed;
    changed = true;
  }
  return changed;
}

function valueSupportRule(state, puzzle) {
  let changed = false;
  for (let c = 0; c < puzzle.cells.length; c++) {
    let support = 0;
    for (const s of state.cellSlots[c]) {
      const st = state.slotState[s];
      if (st === 0) continue; // eliminated
      // For each domino in this slot, what values can c take?
      const [a, b] = puzzle.slots[s];
      const isFirst = a === c;
      const da = state.cellDomain[a];
      const db = state.cellDomain[b];
      for (const k of state.slotDominoes[s]) {
        const x = Math.floor(k / 7), y = k % 7;
        // Orientation A: a=x, b=y
        if ((da & (1 << x)) && (db & (1 << y))) support |= 1 << (isFirst ? x : y);
        // Orientation B: a=y, b=x
        if ((da & (1 << y)) && (db & (1 << x))) support |= 1 << (isFirst ? y : x);
      }
    }
    if (setCellDomain(state, c, state.cellDomain[c] & support)) changed = true;
    if (state.contradiction) return changed;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Brute-force solver (for generation-time uniqueness verification).
// Counts solutions up to a cap; returns at most `cap` distinct solutions.
// Each solution is an object { cellValue: Uint8Array, slots: SlotId[] }.
// ---------------------------------------------------------------------------

/**
 * @param {import('./types.js').Puzzle} puzzle
 * @param {number} cap        Stop after finding this many distinct solutions.
 * @param {number} nodeBudget Stop searching after this many recursion entries (returns
 *                            whatever's been found; treated as "uncertain" upstream).
 */
export function bruteForceCount(puzzle, cap = 2, nodeBudget = 200000) {
  const N = puzzle.cells.length;
  const S = puzzle.slots.length;
  const covered = new Uint8Array(N);
  const placedSlot = []; // stack of placed slot ids
  const cellValue = new Uint8Array(N);
  const bag = puzzle.bag.slice();
  let nodes = 0;
  let aborted = false;

  // Apply region clips for an upper bound on per-cell values.
  const clip = new Uint8Array(N);
  clip.fill(FULL_DOMAIN);
  for (const region of puzzle.regions) {
    const c = region.constraint;
    let mask = FULL_DOMAIN;
    if (c.kind === 'lt') mask = ltMask(c.n);
    else if (c.kind === 'gt') mask = gtMask(c.n);
    if (mask === FULL_DOMAIN) continue;
    for (const cell of region.cells) clip[cell] &= mask;
  }

  const solutions = [];

  // Pre-build cell -> slots mapping.
  const cellSlots = new Array(N);
  for (let i = 0; i < N; i++) cellSlots[i] = [];
  for (let s = 0; s < S; s++) {
    cellSlots[puzzle.slots[s][0]].push(s);
    cellSlots[puzzle.slots[s][1]].push(s);
  }
  // Precompute the non-zero bag entries — typical bag has ~10-20 dominoes vs.
  // the 49-entry indexing space, so iterating only these is a real win.
  const initialBagKeys = [];
  for (let k = 0; k < 49; k++) if (bag[k] > 0) initialBagKeys.push(k);

  function nextUncoveredCell() {
    // Pick the cell with fewest available slots (to prune fast).
    let best = -1, bestN = 1e9;
    for (let c = 0; c < N; c++) {
      if (covered[c]) continue;
      let count = 0;
      for (const s of cellSlots[c]) {
        const [a, b] = puzzle.slots[s];
        if (!covered[a] && !covered[b]) count++;
      }
      if (count < bestN) { bestN = count; best = c; if (count <= 1) break; }
    }
    return best;
  }

  function checkRegionsPartial() {
    // Best-effort early prune: any region whose cells are all assigned must satisfy constraint.
    for (const region of puzzle.regions) {
      let allAssigned = true;
      for (const c of region.cells) if (!covered[c]) { allAssigned = false; break; }
      if (!allAssigned) continue;
      if (!regionSatisfied(region, cellValue)) return false;
    }
    return true;
  }

  function recurse() {
    if (aborted) return;
    if (++nodes > nodeBudget) { aborted = true; return; }
    if (solutions.length >= cap) return;
    const c = nextUncoveredCell();
    if (c < 0) {
      for (const region of puzzle.regions) {
        if (!regionSatisfied(region, cellValue)) return;
      }
      solutions.push({ cellValue: cellValue.slice(), placedSlot: placedSlot.slice() });
      return;
    }
    for (const s of cellSlots[c]) {
      const [a, b] = puzzle.slots[s];
      if (covered[a] || covered[b]) continue;
      const ca = clip[a], cb = clip[b];
      for (const k of initialBagKeys) {
        if (bag[k] <= 0) continue;
        const x = Math.floor(k / 7), y = k % 7;
        for (const [va, vb] of (x === y ? [[x, y]] : [[x, y], [y, x]])) {
          if (!(ca & (1 << va))) continue;
          if (!(cb & (1 << vb))) continue;
          covered[a] = 1; covered[b] = 1;
          cellValue[a] = va; cellValue[b] = vb;
          bag[k] -= 1; placedSlot.push(s);
          if (checkRegionsPartial()) recurse();
          covered[a] = 0; covered[b] = 0;
          bag[k] += 1; placedSlot.pop();
          if (aborted || solutions.length >= cap) return;
        }
      }
    }
  }
  recurse();
  // If we aborted, signal "uncertain" by returning more than `cap` solutions
  // (callers treat >1 as non-unique → reject).
  if (aborted) return [{ aborted: true }, { aborted: true }];
  return solutions;
}

function regionSatisfied(region, cellValue) {
  const c = region.constraint;
  const vals = region.cells.map((id) => cellValue[id]);
  switch (c.kind) {
    case 'sum': return vals.reduce((s, v) => s + v, 0) === c.n;
    case 'eq': return vals.every((v) => v === vals[0]);
    case 'neq': return new Set(vals).size === vals.length;
    case 'lt': return vals.every((v) => v < c.n);
    case 'gt': return vals.every((v) => v > c.n);
    case 'blank': return true;
  }
  return true;
}
