// Renders a single domino as a DOM element with two halves.
// The element holds dataset.id (piece id) and dataset.flipped (0/1).

import { el } from './dom.js';
import { pipsForValue } from './pips.js';

/**
 * @param {{id: string, a: number, b: number, flipped: boolean, orientation: 'horizontal'|'vertical'}} piece
 */
export function makeDominoEl(piece) {
  const root = el('div', {
    class: `domino ${piece.orientation}`,
    data: { id: piece.id, flipped: piece.flipped ? 1 : 0 },
  });
  renderHalves(root, piece);
  return root;
}

export function renderHalves(root, piece) {
  // Clear existing halves.
  root.classList.remove('horizontal', 'vertical');
  root.classList.add(piece.orientation);
  while (root.firstChild) root.removeChild(root.firstChild);
  const first = piece.flipped ? piece.b : piece.a;
  const second = piece.flipped ? piece.a : piece.b;
  const h1 = el('div', { class: 'half' }, ...pipsForValue(first));
  const h2 = el('div', { class: 'half' }, ...pipsForValue(second));
  root.appendChild(h1);
  root.appendChild(h2);
  root.dataset.flipped = piece.flipped ? '1' : '0';
}
