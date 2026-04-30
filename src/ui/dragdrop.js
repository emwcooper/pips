// Pointer-based drag, drop, and click-to-rotate for domino pieces.
//
// One module-wide instance attaches a pointerdown handler at the document level
// (event delegation) so we don't need to re-bind on every render.

const CLICK_MOVE_THRESHOLD = 8; // px
const SNAP_THRESHOLD_FRACTION = 0.75; // of cell size

let installed = false;
let api = null; // populated by attach()

/**
 * @param {{
 *   getPieceById: (id: string) => any,
 *   getBoardEl: () => HTMLElement,
 *   getTrayEl: () => HTMLElement,
 *   getSlotsViewport: () => Array<{slotIdx:number, x:number, y:number, w:number, h:number, horizontal:boolean}>,
 *   getCellSize: () => number,
 *   getSlotForPiece: (id: string) => number | null,
 *   isSlotOccupied: (slotIdx: number) => boolean,
 *   onPlace: (pieceId: string, slotIdx: number) => void,
 *   onUnplace: (pieceId: string, trayIndex?: number) => void,
 *   onRotate: (pieceId: string) => void,
 * }} hooks
 */
export function attach(hooks) {
  api = hooks;
  if (installed) return;
  installed = true;

  document.addEventListener('pointerdown', onPointerDown);
}

let drag = null; // { pieceId, el, startX, startY, lastX, lastY, originParent, originNext, dragging, offsetX, offsetY }

function onPointerDown(ev) {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  // If a drag is already in progress (e.g., from a different pointer), ignore.
  // Otherwise rapid pointerdowns would attach duplicate listeners on the same
  // persistent element without ever removing them.
  if (drag) return;
  const target = ev.target.closest('.domino');
  if (!target) return;
  ev.preventDefault();

  const pieceId = target.dataset.id;
  const rect = target.getBoundingClientRect();
  const piece = api.getPieceById(pieceId);
  const placed = !!(piece && piece.placedSlot !== null);
  const locked = !!(piece && piece.locked);

  drag = {
    pieceId,
    el: target,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    lastX: ev.clientX,
    lastY: ev.clientY,
    offsetX: ev.clientX - rect.left,
    offsetY: ev.clientY - rect.top,
    originParent: target.parentNode,
    originNext: target.nextSibling,
    pieceWidth: rect.width,
    pieceHeight: rect.height,
    dragging: false,
    placed,
    locked,
    boardRect: api.getBoardEl().getBoundingClientRect(),
    slots: api.getSlotsViewport(),
    cellSize: api.getCellSize(),
  };

  // Listen at the document level instead of on the dragged element. This
  // avoids the well-known issue where pointer capture can be lost when the
  // dragged element is reparented (e.g., to <body> for the drag visual),
  // which would make subsequent pointermoves silently stop firing on it.
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  drag.lastX = ev.clientX;
  drag.lastY = ev.clientY;
  const dx = ev.clientX - drag.startX;
  const dy = ev.clientY - drag.startY;
  const moved = Math.hypot(dx, dy);
  if (!drag.dragging) {
    if (moved < CLICK_MOVE_THRESHOLD) return;
    // Locked placed pieces refuse drag; pointer-up will fall through to a
    // click that toggles the lock off.
    if (drag.locked) return;
    enterDragMode();
  }
  positionDragEl(ev.clientX, ev.clientY);
  highlightNearestSlot(ev.clientX, ev.clientY);
}

function enterDragMode() {
  drag.dragging = true;
  const el = drag.el;
  // Reparent to body, position:fixed.
  document.body.appendChild(el);
  el.classList.add('dragging');
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.pointerEvents = 'auto';
}

function positionDragEl(clientX, clientY) {
  drag.el.style.transform = `translate(${clientX - drag.offsetX}px, ${clientY - drag.offsetY}px)`;
}

function slotEmptyForDrag(slotIdx) {
  if (!api.isSlotOccupied(slotIdx)) return true;
  // Allow dropping back onto the piece's own current slot.
  const piece = api.getPieceById(drag.pieceId);
  return piece && piece.placedSlot === slotIdx;
}

function highlightNearestSlot(clientX, clientY) {
  const boardRect = drag.boardRect;
  const slots = drag.slots;
  const cellSize = drag.cellSize;
  const snapPx = SNAP_THRESHOLD_FRACTION * cellSize;
  // Domino center in viewport coords (where the piece itself is, not the cursor).
  const dcx = clientX - drag.offsetX + drag.pieceWidth / 2;
  const dcy = clientY - drag.offsetY + drag.pieceHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const s of slots) {
    if (!slotEmptyForDrag(s.slotIdx)) continue;
    const cx = s.x + boardRect.left + s.w / 2;
    const cy = s.y + boardRect.top + s.h / 2;
    const d = Math.hypot(dcx - cx, dcy - cy);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  let highlight = document.getElementById('slot-highlight');
  if (!highlight) {
    highlight = document.createElement('div');
    highlight.id = 'slot-highlight';
    highlight.className = 'slot-highlight';
    document.body.appendChild(highlight);
    highlight.style.position = 'fixed';
  }
  if (best && bestDist <= snapPx) {
    highlight.style.left = `${boardRect.left + best.x}px`;
    highlight.style.top = `${boardRect.top + best.y}px`;
    highlight.style.width = `${best.w}px`;
    highlight.style.height = `${best.h}px`;
    highlight.classList.add('show');
  } else {
    highlight.classList.remove('show');
  }
}

function onPointerUp(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const target = drag.el;
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);

  // Reset drag visual styles so the element falls back to its CSS-defined
  // position (absolute, with left/top set inline by the action handlers).
  target.classList.remove('dragging');
  target.style.transform = '';
  target.style.position = '';
  target.style.pointerEvents = '';

  const wasClick = !drag.dragging;
  if (wasClick) {
    if (drag.placed) api.onLockToggle(drag.pieceId);
    else api.onRotate(drag.pieceId);
    drag = null;
    return;
  }

  // Hit-test for slot using cached values, measured from the domino's center.
  const boardRect = drag.boardRect;
  const slots = drag.slots;
  const snapPx = SNAP_THRESHOLD_FRACTION * drag.cellSize;
  const dcx = ev.clientX - drag.offsetX + drag.pieceWidth / 2;
  const dcy = ev.clientY - drag.offsetY + drag.pieceHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const s of slots) {
    if (!slotEmptyForDrag(s.slotIdx)) continue;
    const cx = s.x + boardRect.left + s.w / 2;
    const cy = s.y + boardRect.top + s.h / 2;
    const d = Math.hypot(dcx - cx, dcy - cy);
    if (d < bestDist) { bestDist = d; best = s; }
  }

  const highlight = document.getElementById('slot-highlight');
  if (highlight) highlight.classList.remove('show');

  // Action handlers reparent the same element via appendChild — no need to
  // remove it manually here.
  if (best && bestDist <= snapPx) {
    api.onPlace(drag.pieceId, best.slotIdx);
  } else {
    const trayPos = trayDropPos(ev.clientX, ev.clientY);
    api.onUnplace(drag.pieceId, trayPos);
  }
  drag = null;
}

function trayDropPos(clientX, clientY) {
  if (!api.getTrayEl) return undefined;
  const tray = api.getTrayEl();
  if (!tray) return undefined;
  const trayRect = tray.getBoundingClientRect();
  // Allow drops slightly outside the tray to still snap into it.
  const margin = api.getCellSize();
  const inside =
    clientX >= trayRect.left - margin && clientX <= trayRect.right + margin &&
    clientY >= trayRect.top - margin && clientY <= trayRect.bottom + margin;
  if (!inside) return undefined;
  // Anchor by the cursor offset within the dragged piece, so the piece lands
  // "under" the cursor where the user grabbed it.
  const x = clientX - trayRect.left - drag.offsetX;
  const y = clientY - trayRect.top - drag.offsetY;
  // Clamp inside the tray's content area, accounting for piece size.
  const w = drag.pieceWidth;
  const h = drag.pieceHeight;
  const maxX = Math.max(0, trayRect.width - w);
  const maxY = Math.max(0, trayRect.height - h);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}
