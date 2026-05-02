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
import { reportWinToGlobal, flushPendingGlobalSync } from '../stats/global.js';
import { renderStats } from './stats.js';
import { showCelebration } from './celebrate.js';
import { showInstructions } from './instructions.js';
import { clear } from './dom.js';

export function startApp() {
  const boardEl = document.getElementById('board');
  const trayEl = document.getElementById('tray');
  const statusEl = document.getElementById('status');
  const timerEl = document.getElementById('timer');
  const newBtn = document.getElementById('new-puzzle');
  const clearBtn = document.getElementById('clear-all');
  const statsBtn = document.getElementById('toggle-stats');
  const instructionsBtn = document.getElementById('show-instructions');
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

    state = newAppState(puzzle, trayEl.clientWidth);
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
    // Debug helper: in DevTools you can read window.__pipsDebug to inspect the
    // current puzzle's regions, constraints, and known solution.
    window.__pipsDebug = {
      puzzle,
      solution: Array.from(puzzle.solution.cellValue),
      regions: puzzle.regions.map((r) => ({
        id: r.id,
        constraint: r.constraint,
        cells: r.cells.map((c) => ({ id: c, row: puzzle.cells[c].row, col: puzzle.cells[c].col, value: puzzle.solution.cellValue[c] })),
      })),
      state,
      boardRenderInfo,
    };
  }

  // ---------- piece operations (move-in-place, never recreate the element) ----------

  function placePieceOnBoard(piece, slotIdx) {
    // Slots are pairs of cells, and adjacent slots share a cell. Evict any
    // already-placed piece whose slot overlaps the new placement (not just
    // the same slotIdx). Without this, two pieces on overlapping slots end
    // up visually stacked on the shared cell.
    const newCells = state.puzzle.slots[slotIdx];
    for (const occupant of state.pieces) {
      if (occupant === piece || occupant.placedSlot === null) continue;
      const [a, b] = state.puzzle.slots[occupant.placedSlot];
      const overlaps = a === newCells[0] || a === newCells[1] || b === newCells[0] || b === newCells[1];
      if (!overlaps) continue;
      occupant.placedSlot = null;
      occupant.locked = false;
      occupant.el.classList.remove('locked');
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
    piece.locked = false;
    piece.el.classList.remove('locked');
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

  function toggleLock(piece) {
    if (piece.placedSlot === null) return;
    piece.locked = !piece.locked;
    piece.el.classList.toggle('locked', piece.locked);
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
        const winInfo = recordWin(elapsed, difficulty);
        reportWinToGlobal(difficulty, elapsed);
        let msg = `Solved in ${formatMs(elapsed)}!`;
        if (winInfo.totalWins >= 3) {
          msg += `  ·  ${winInfo.percentile}th percentile (${difficulty})`;
        }
        statusEl.textContent = msg;
        statusEl.className = 'status good';
        if (winInfo.isNewFastest) {
          const text = winInfo.wasFirst
            ? `First ${difficulty} solve!`
            : `Fastest ${difficulty} ever!`;
          showCelebration(text);
        }
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
    // "Occupied" here means "no-snap": the slot is blocked when a *locked*
    // piece's cells overlap. Unlocked overlapping pieces don't block — they'll
    // be evicted on drop by placePieceOnBoard.
    isSlotOccupied: (slotIdx) => {
      const cells = state.puzzle.slots[slotIdx];
      return state.pieces.some((p) => {
        if (!p.locked || p.placedSlot === null) return false;
        const [a, b] = state.puzzle.slots[p.placedSlot];
        return a === cells[0] || a === cells[1] || b === cells[0] || b === cells[1];
      });
    },
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
    onLockToggle: (pieceId) => {
      const piece = state.pieces.find((p) => p.id === pieceId);
      if (!piece) return;
      toggleLock(piece);
    },
  });

  // ---------- buttons / timer ----------

  newBtn.addEventListener('click', () => {
    if (state && !state.won) recordGiveUp(difficulty);
    stopTimer();
    requestPuzzle();
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!state) return;
      const placed = state.pieces.filter((p) => p.placedSlot !== null);
      if (placed.length === 0) return;
      const unlockedPlaced = placed.filter((p) => !p.locked);
      const targets = unlockedPlaced.length > 0 ? unlockedPlaced : placed;
      for (const piece of targets) returnPieceToTray(piece);
    });
  }

  if (instructionsBtn) {
    instructionsBtn.addEventListener('click', () => showInstructions());
  }

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
      // Attribute any in-progress give-up to the difficulty being left, not the new one.
      const previous = difficulty;
      difficulty = next;
      saveDifficulty(difficulty);
      paintDifficulty();
      // Tell the worker to drop its (now-stale) queue and re-generate.
      if (!workerErrored) worker.postMessage({ type: 'setDifficulty', difficulty });
      if (state && !state.won) recordGiveUp(previous);
      stopTimer();
      requestPuzzle();
    });
  });
  paintDifficulty();
  // Tell worker the initial difficulty before the first request.
  if (!workerErrored) worker.postMessage({ type: 'setDifficulty', difficulty });

  // Kick off.
  requestPuzzle();

  // Catch-up: send any local wins not yet reported to the global backend
  // (e.g. earned before global stats existed, or while offline). Runs
  // in the background — never blocks the UI.
  flushPendingGlobalSync();
}

function newAppState(puzzle, trayWidthPx) {
  /** @type {Array<{id:string,a:number,b:number,flipped:boolean,orientation:string,placedSlot:number|null,trayX:number,trayY:number,el:HTMLElement}>} */
  const pieces = [];
  let n = 0;
  const cellPx = resolveCellPx();
  const HSPACE = 2 * cellPx + 10;
  const VSPACE = cellPx + 10;
  // Pack as many domino columns as fit into the actual tray width.
  const trayInner = (trayWidthPx || 720) - 24;
  const COLS = Math.max(1, Math.min(4, Math.floor(trayInner / HSPACE)));
  // Center the packed block inside the tray instead of leaving empty space to
  // the right. Block width is (COLS-1) gaps + last piece width.
  const blockWidth = (COLS - 1) * HSPACE + 2 * cellPx;
  const xOffset = Math.max(12, Math.floor((trayInner - blockWidth) / 2) + 12);
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
        locked: false,
        trayX: (idx % COLS) * HSPACE + xOffset,
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

// --cell is a clamp() expression, so getPropertyValue returns the unresolved
// text. Read the resolved pixel value by setting `width: var(--cell)` on a
// throwaway element and reading its computed width.
function resolveCellPx() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--cell);height:var(--cell);';
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w || 56;
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
