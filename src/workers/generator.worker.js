// Web Worker entry. Maintains a queue of pre-generated puzzles so the main
// thread (UI) can grab one instantly. Continuously generates in the background
// until the queue is at target depth.
//
// Protocol:
//   main → worker: { type: 'request' }      — request a puzzle (now or as soon as ready)
//   worker → main: { type: 'puzzle', ... }  — delivers a puzzle
//   worker → main: { type: 'queue', size }  — periodic queue-depth update
//   worker → main: { type: 'error', message }

import { generatePuzzle } from '../puzzle/generator.js';

const TARGET_QUEUE_DEPTH = 4;

/** @type {Array<{puzzle: any, durationMs: number, attempts: number}>} */
const queue = [];
const pendingRequests = []; // resolves when a puzzle is ready
let generating = false;
let currentDifficulty = 'easy';

function postQueueStatus() {
  self.postMessage({ type: 'queue', size: queue.length });
}

function deliverNext() {
  if (queue.length === 0 || pendingRequests.length === 0) return;
  const out = queue.shift();
  const resolve = pendingRequests.shift();
  resolve(out);
  postQueueStatus();
}

async function generateLoop() {
  if (generating) return;
  generating = true;
  while (queue.length < TARGET_QUEUE_DEPTH) {
    try {
      const diff = currentDifficulty;
      const out = generatePuzzle(Math.random, { difficulty: diff });
      out.difficulty = diff;
      queue.push(out);
      postQueueStatus();
      deliverNext();
    } catch (e) {
      self.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  generating = false;
}

function ensureGenerating() {
  if (!generating) generateLoop();
}

function handleRequest(reply) {
  if (queue.length > 0) {
    const out = queue.shift();
    reply(out);
    postQueueStatus();
  } else {
    pendingRequests.push(reply);
  }
  ensureGenerating();
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'setDifficulty') {
    if (msg.difficulty && msg.difficulty !== currentDifficulty) {
      currentDifficulty = msg.difficulty;
      // Drop any queued puzzles of the previous difficulty.
      queue.length = 0;
      postQueueStatus();
      ensureGenerating();
    }
  } else if (msg.type === 'request') {
    handleRequest((out) => {
      self.postMessage({
        type: 'puzzle',
        puzzle: serializePuzzle(out.puzzle),
        durationMs: out.durationMs,
        attempts: out.attempts,
      });
    });
  }
};

// Start background generation immediately so the first request is fast.
ensureGenerating();

function serializePuzzle(p) {
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
