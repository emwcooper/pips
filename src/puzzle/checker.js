// Checks whether a fully-placed player solution is correct.
// Input: puzzle, plus a per-cell value array reflecting the player's placements.
// Returns { ok: true } or { ok: false, reason }.

/**
 * @param {import('./types.js').Puzzle} puzzle
 * @param {Uint8Array | number[]} cellValue
 */
export function checkSolution(puzzle, cellValue) {
  for (const region of puzzle.regions) {
    const vals = region.cells.map((id) => cellValue[id]);
    const c = region.constraint;
    let ok = true;
    switch (c.kind) {
      case 'sum': ok = vals.reduce((s, v) => s + v, 0) === c.n; break;
      case 'eq': ok = vals.every((v) => v === vals[0]); break;
      case 'neq': ok = new Set(vals).size === vals.length; break;
      case 'lt': ok = vals.every((v) => v < c.n); break;
      case 'gt': ok = vals.every((v) => v > c.n); break;
      case 'blank': ok = true; break;
    }
    if (!ok) return { ok: false, reason: `region ${region.id} fails constraint ${describeConstraint(c)}` };
  }
  return { ok: true };
}

export function describeConstraint(c) {
  switch (c.kind) {
    case 'sum': return `${c.n}`;
    case 'eq': return '=';
    case 'neq': return '≠';
    case 'lt': return `<${c.n}`;
    case 'gt': return `>${c.n}`;
    case 'blank': return '';
  }
  return '';
}
