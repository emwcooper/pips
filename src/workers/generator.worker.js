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

// One queue per difficulty so switching modes doesn't throw away pre-generated
// puzzles for the mode you came from.
/** @type {Record<string, Array<{puzzle: any, durationMs: number, attempts: number}>>} */
const queues = { easy: [], medium: [], hard: [], logic: [] };
const pendingRequests = []; // each waiting on currentDifficulty's queue
let generating = false;
let currentDifficulty = 'easy';

function curQueue() { return queues[currentDifficulty] || (queues[currentDifficulty] = []); }

function postQueueStatus() {
  self.postMessage({ type: 'queue', size: curQueue().length });
}

function deliverNext() {
  const q = curQueue();
  if (q.length === 0 || pendingRequests.length === 0) return;
  const out = q.shift();
  const resolve = pendingRequests.shift();
  resolve(out);
  postQueueStatus();
}

async function generateLoop() {
  if (generating) return;
  generating = true;
  // Generate until the *current* difficulty's queue is full. Switching mode
  // breaks out of this naturally on the next iteration since we re-read
  // currentDifficulty each time.
  while (curQueue().length < TARGET_QUEUE_DEPTH) {
    try {
      const diff = currentDifficulty;
      const out = generatePuzzle(Math.random, { difficulty: diff });
      out.difficulty = diff;
      queues[diff].push(out);
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
  const q = curQueue();
  if (q.length > 0) {
    const out = q.shift();
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
      // Don't clear queues — each difficulty keeps its own pre-generated
      // puzzles so switching back is instant.
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
