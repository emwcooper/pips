// JSDoc type definitions used throughout the puzzle code.
// This file exports nothing at runtime; it exists for editor IntelliSense.

/**
 * @typedef {number} CellId   Index into puzzle.cells.
 * @typedef {number} SlotId   Index into puzzle.slots.
 * @typedef {number} DominoKey  0..48 (a*7+b with a<=b).
 *
 * @typedef {{kind:'sum',n:number}
 *         | {kind:'eq'}
 *         | {kind:'neq'}
 *         | {kind:'lt',n:number}
 *         | {kind:'gt',n:number}
 *         | {kind:'blank'}} Constraint
 *
 * @typedef {Object} Puzzle
 * @property {number} width    Bounding box width.
 * @property {number} height   Bounding box height.
 * @property {{row:number,col:number,region:number}[]} cells   Playable cells (CellId is the index).
 * @property {Int32Array} cellAtRC  Length width*height, value = CellId or -1 if blocked.
 * @property {[CellId,CellId][]} slots   All adjacent-pair candidate slots (orientation determined by cell positions).
 * @property {{id:number,cells:CellId[],constraint:Constraint}[]} regions
 * @property {number[]} bag    Length 49: count of each domino key in the puzzle's multiset.
 * @property {{cellValue:Uint8Array, slotPairs:[CellId,CellId][]}} solution
 *
 * @typedef {Object} SolverResult
 * @property {'solved'|'stalled'|'contradiction'} status
 * @property {Uint8Array=} cellValue   Present iff status==='solved'.
 * @property {SlotId[]=} placedSlots   Present iff status==='solved'.
 */
export {};
