// Renders the tray of unplaced dominoes at their per-piece tray coordinates
// (free-form drop positions). Each piece carries trayX/trayY relative to the
// tray's content area; rotation and orientation are also per-piece.

import { clear } from './dom.js';
import { makeDominoEl } from './domino.js';

/**
 * @param {HTMLElement} trayEl
 * @param {Array<{id:string,a:number,b:number,flipped:boolean,orientation:'horizontal'|'vertical',placedSlot:number|null,trayX:number,trayY:number}>} pieces
 */
export function renderTray(trayEl, pieces) {
  clear(trayEl);
  for (const piece of pieces) {
    if (piece.placedSlot !== null) continue;
    if (!piece.orientation) piece.orientation = 'horizontal';
    const node = makeDominoEl(piece);
    node.style.left = `${piece.trayX || 0}px`;
    node.style.top = `${piece.trayY || 0}px`;
    trayEl.appendChild(node);
  }
}
