// Top-level app controller.
//
// Each piece has a *persistent* DOM element that we move around (between tray
// and board) rather than destroying and recreating. Click rotates in place;
// drag moves the same element. This avoids duplicates and stale references.

import { renderBoard } from './board.js';
import { makeDominoEl, renderHalves } from './domino.js';
import { attach as attachDragDrop } from './dragdrop.js';
import { checkSolution } from '../puzzle/checker.js';
import { decodeKey } from '../puzzle/domino.js';
import { generatePuzzle } from '../puzzle/generator.js';
import { recordWin, recordGiveUp, loadDifficulty, saveDifficulty } from '../stats/storage.js';
import { renderStats } from './stats.js';
import { clear } from './dom.js';

export function startApp() {
  const boardEl = document.getElementById('board');
  const trayEl = document.getElementById('tray');
  const statusEl = document.getElementById('status');
  const timerEl = document.getElementById('timer');
  const newBtn = document.getElementById('new-puzzle');
  const statsBtn = document.getElementById('toggle-stats');
  const statsPanel = document.getElementById('stats-panel');
  const loadingEl = document.getElementById('loading');

  let state = null;
  let boardRenderInfo = null;
  let timerInterval = null;
  let difficulty = loadDifficulty();

  // Background pre-generation via Web Worker (keeps the UI responsive during
  // the ~1s generation). Falls back to main-thread generation if the worker
  // errors out or doesn't deliver within a reasonable time.
  const worker = new Worker(new URL('../workers/generator.worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('error', (e) => {
    console.error('Worker error:', e.message);
    workerErrored = true;
    generateInline();
  });
  let workerErrored = false;
  let workerTimeoutId = null;
  let pendingNewPuzzle = false;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'puzzle') {
      pendingNewPuzzle = false;
      if (workerTimeoutId) { clearTimeout(workerTimeoutId); workerTimeoutId = null; }
      installPuzzle(msg.puzzle, msg.durationMs);
    } else if (msg.type === 'error') {
      console.error('worker reported error:', msg.message);
      workerErrored = true;
      if (workerTimeoutId) { clearTimeout(workerTimeoutId); workerTimeoutId = null; }
      generateInline();
    } else if (msg.type === 'queue') {
      if (!state) {
        loadingEl.textContent = msg.size > 0 ? 'Loading puzzle…' : 'Generating first puzzle…';
      }
    }
  };

  function generateInline() {
    setTimeout(() => {
      try {
        const out = generatePuzzle(Math.random, { difficulty });
        pendingNewPuzzle = false;
        installPuzzle(serializePuzzleForInstall(out.puzzle), out.durationMs);
      } catch (e) {
        statusEl.textContent = `Generator error: ${e && e.message ? e.message : e}`;
        statusEl.className = 'status bad';
        loadingEl.classList.add('hidden');
        pendingNewPuzzle = false;
      }
    }, 0);
  }

  function requestPuzzle() {
    loadingEl.classList.remove('hidden');
    loadingEl.textContent = 'Generating puzzle…';
    statusEl.textContent = '';
    statusEl.className = 'status';
    pendingNewPuzzle = true;
    if (workerErrored) {
      generateInline();
    } else {
      worker.postMessage({ type: 'request' });
      // If the worker doesn't respond within a few seconds, give up and run
      // on the main thread.
      if (workerTimeoutId) clearTimeout(workerTimeoutId);
      workerTimeoutId = setTimeout(() => {
        if (!pendingNewPuzzle) return; // already got it
        console.warn('Worker timeout; falling back to main-thread generation');
        workerErrored = true;
        generateInline();
      }, 4000);
    }
  }

  function serializePuzzleForInstall(p) {
    // installPuzzle expects worker-shaped data; mirror the worker's serialization.
    return {
      width: p.width,
      height: p.height,
      cells: p.cells,
      cellAtRC: Array.from(p.cellAtRC),
      slots: p.slots,
      regions: p.regions,
      bag: Array.from(p.bag),
      solution: {
        cellValue: Array.from(p.solution.cellValue),
        slotPairs: p.solution.slotPairs,
      },
    };
  }

  function installPuzzle(puzzle, durationMs) {
    // Clean up any orphaned elements from a previous puzzle.
    document.querySelectorAll('body > .domino').forEach((n) => n.remove());
    const stale = document.getElementById('slot-highlight');
    if (stale) stale.remove();

    puzzle.cellAtRC = Int32Array.from(puzzle.cellAtRC);
    puzzle.solution.cellValue = Uint8Array.from(puzzle.solution.cellValue);

    state = newAppState(puzzle);
    boardRenderInfo = renderBoard(boardEl, puzzle);

    // Tray gets fresh DOM; pieces are appended directly with their own elements.
    clear(trayEl);
    for (const piece of state.pieces) {
      piece.el.style.left = piece.trayX + 'px';
      piece.el.style.top = piece.trayY + 'px';
      trayEl.appendChild(piece.el);
    }

    loadingEl.classList.add('hidden');
    startTimer();
    statusEl.textContent = '';
    statusEl.className = 'status';
    if (durationMs != null) console.log(`generated in ${Math.round(durationMs)}ms`);
  }

  // ---------- piece operations (move-in-place, never recreate the element) ----------

  function placePieceOnBoard(piece, slotIdx) {
    // If another piece already occupies this slot, evict it back to its tray spot.
    const occupant = state.pieces.find((p) => p.placedSlot === slotIdx && p !== piece);
    if (occupant) {
      occupant.placedSlot = null;
      occupant.el.style.left = occupant.trayX + 'px';
      occupant.el.style.top = occupant.trayY + 'px';
      trayEl.appendChild(occupant.el);
    }
    piece.placedSlot = slotIdx;
    const r = boardRenderInfo.slotRect(slotIdx);
    piece.orientation = r.horizontal ? 'horizontal' : 'vertical';
    renderHalves(piece.el, piece);
    piece.el.style.left = r.x + 'px';
    piece.el.style.top = r.y + 'px';
    boardEl.appendChild(piece.el);
    checkComplete();
  }

  function returnPieceToTray(piece, trayPos) {
    piece.placedSlot = null;
    if (trayPos) {
      piece.trayX = trayPos.x;
      piece.trayY = trayPos.y;
    }
    piece.el.style.left = piece.trayX + 'px';
    piece.el.style.top = piece.trayY + 'px';
    trayEl.appendChild(piece.el);
    // Re-evaluate status (a placed-piece may have just been pulled off after a win).
    checkComplete();
  }

  function rotatePiece(piece) {
    if (piece.placedSlot !== null) {
      // Placed: only flip which value goes in which cell; orientation is fixed.
      piece.flipped = !piece.flipped;
    } else {
      // Tray: 90° clockwise cycle through 4 states.
      // (h,F) → (v,F) → (h,T) → (v,T) → (h,F)
      if (piece.orientation === 'horizontal' && !piece.flipped) {
        piece.orientation = 'vertical';
      } else if (piece.orientation === 'vertical' && !piece.flipped) {
        piece.orientation = 'horizontal';
        piece.flipped = true;
      } else if (piece.orientation === 'horizontal' && piece.flipped) {
        piece.orientation = 'vertical';
      } else {
        piece.orientation = 'horizontal';
        piece.flipped = false;
      }
    }
    renderHalves(piece.el, piece);
    if (piece.placedSlot !== null) checkComplete();
  }

  function checkComplete() {
    const allPlaced = state.pieces.every((p) => p.placedSlot !== null);
    if (allPlaced && !state.won) {
      const cellValue = computeCellValues(state);
      const result = checkSolution(state.puzzle, cellValue);
      if (result.ok) {
        state.won = true;
        const elapsed = Date.now() - state.startedAt;
        stopTimer();
        recordWin(elapsed);
        statusEl.textContent = `Solved in ${formatMs(elapsed)}!`;
        statusEl.className = 'status good';
        if (!statsPanel.classList.contains('hidden')) renderStats(statsPanel, requestPuzzle);
      } else {
        statusEl.textContent = `Not quite — keep trying.`;
        statusEl.className = 'status bad';
      }
    } else if (!state.won) {
      statusEl.textContent = '';
      statusEl.className = 'status';
    }
  }

  // ---------- drag/drop hookup ----------

  attachDragDrop({
    getPieceById: (id) => state.pieces.find((p) => p.id === id),
    getBoardEl: () => boardEl,
    getTrayEl: () => trayEl,
    getSlotsViewport: () => {
      const rects = boardRenderInfo.allSlotRects();
      const out = new Array(rects.length);
      for (let s = 0; s < rects.length; s++) {
        const r = rects[s];
        out[s] = { slotIdx: s, x: r.x, y: r.y, w: r.w, h: r.h, horizontal: r.horizontal };
      }
      return out;
    },
    getCellSize: () => boardRenderInfo ? boardRenderInfo.cellPx : 56,
    getSlotForPiece: (id) => {
      const p = state.pieces.find((pp) => pp.id === id);
      return p ? p.placedSlot : null;
    },
    isSlotOccupied: (slotIdx) => state.pieces.some((p) => p.placedSlot === slotIdx),
    onPlace: (pieceId, slotIdx) => {
      const piece = state.pieces.find((p) => p.id === pieceId);
      if (!piece) return;
      placePieceOnBoard(piece, slotIdx);
    },
    onUnplace: (pieceId, trayPos) => {
      const piece = state.pieces.find((p) => p.id === pieceId);
      if (!piece) return;
      returnPieceToTray(piece, trayPos);
    },
    onRotate: (pieceId) => {
      const piece = state.pieces.find((p) => p.id === pieceId);
      if (!piece) return;
      rotatePiece(piece);
    },
  });

  // ---------- buttons / timer ----------

  newBtn.addEventListener('click', () => {
    if (state && !state.won) recordGiveUp();
    stopTimer();
    requestPuzzle();
  });

  statsBtn.addEventListener('click', () => {
    if (statsPanel.classList.contains('hidden')) {
      statsPanel.classList.remove('hidden');
      statsPanel.setAttribute('aria-hidden', 'false');
      renderStats(statsPanel, requestPuzzle);
    } else {
      statsPanel.classList.add('hidden');
      statsPanel.setAttribute('aria-hidden', 'true');
    }
  });

  function startTimer() {
    state.startedAt = Date.now();
    state.won = false;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!state) return;
      timerEl.textContent = formatMs(Date.now() - state.startedAt);
    }, 250);
    timerEl.textContent = '0:00';
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // Difficulty selector.
  function paintDifficulty() {
    document.querySelectorAll('.diff-btn').forEach((btn) => {
      const matches = btn.dataset.diff === difficulty;
      btn.setAttribute('aria-pressed', matches ? 'true' : 'false');
    });
  }
  document.querySelectorAll('.diff-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.diff;
      if (next === difficulty) return;
      difficulty = next;
      saveDifficulty(difficulty);
      paintDifficulty();
      // Tell the worker to drop its (now-stale) queue and re-generate.
      if (!workerErrored) worker.postMessage({ type: 'setDifficulty', difficulty });
      // Treat current puzzle as a give-up if the player was mid-solve.
      if (state && !state.won) recordGiveUp();
      stopTimer();
      requestPuzzle();
    });
  });
  paintDifficulty();
  // Tell worker the initial difficulty before the first request.
  if (!workerErrored) worker.postMessage({ type: 'setDifficulty', difficulty });

  // Kick off.
  requestPuzzle();
}

function newAppState(puzzle) {
  /** @type {Array<{id:string,a:number,b:number,flipped:boolean,orientation:string,placedSlot:number|null,trayX:number,trayY:number,el:HTMLElement}>} */
  const pieces = [];
  let n = 0;
  const cellPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 56;
  const HSPACE = 2 * cellPx + 10;
  const VSPACE = cellPx + 10;
  const COLS = 4;
  for (let k = 0; k < 49; k++) {
    const count = puzzle.bag[k] | 0;
    if (!count) continue;
    const [a, b] = decodeKey(k);
    for (let i = 0; i < count; i++) {
      const idx = n;
      const piece = {
        id: `p${n++}`,
        a, b,
        flipped: false,
        orientation: 'horizontal',
        placedSlot: null,
        trayX: (idx % COLS) * HSPACE + 12,
        trayY: Math.floor(idx / COLS) * VSPACE + 12,
        el: null,
      };
      piece.el = makeDominoEl(piece);
      pieces.push(piece);
    }
  }
  return {
    puzzle,
    pieces,
    startedAt: Date.now(),
    won: false,
  };
}

function computeCellValues(state) {
  const cellValue = new Uint8Array(state.puzzle.cells.length);
  for (const piece of state.pieces) {
    if (piece.placedSlot === null) continue;
    const [a, b] = state.puzzle.slots[piece.placedSlot];
    const first = piece.flipped ? piece.b : piece.a;
    const second = piece.flipped ? piece.a : piece.b;
    cellValue[a] = first;
    cellValue[b] = second;
  }
  return cellValue;
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}
