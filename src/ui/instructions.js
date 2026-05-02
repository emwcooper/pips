// Instructions modal: a single overlay that explains the rules. Mounted
// lazily on first show; subsequent shows reuse the same DOM.

import { el } from './dom.js';

let overlay = null;

function build() {
  const card = el('div', { class: 'instructions-card' });

  const closeBtn = el('button', { type: 'button', class: 'instructions-close', 'aria-label': 'Close' }, '×');
  closeBtn.addEventListener('click', hide);
  card.appendChild(closeBtn);

  card.appendChild(el('h2', {}, 'How to play'));

  card.appendChild(el('p', {},
    'Drag dominoes from the tray onto the board so every region’s constraint is satisfied.',
  ));

  const list = el('ul');
  list.appendChild(el('li', {},
    el('strong', {}, 'N'),
    ' — the cells of this region must sum to N. ',
    'On a single-cell region this just labels the value.',
  ));
  list.appendChild(el('li', {},
    el('strong', {}, '<N'),
    ' / ',
    el('strong', {}, '>N'),
    ' — the region’s cells sum to less than (or greater than) N.',
  ));
  list.appendChild(el('li', {},
    el('strong', {}, '='),
    ' — every cell in the region has the same value.',
  ));
  list.appendChild(el('li', {},
    el('strong', {}, '≠'),
    ' — every cell in the region has a different value.',
  ));
  list.appendChild(el('li', {},
    'Unmarked regions have no constraint.',
  ));
  card.appendChild(list);

  card.appendChild(el('h3', {}, 'Controls'));
  const controls = el('ul');
  controls.appendChild(el('li', {}, 'Drag a tray domino onto the board to place it.'));
  controls.appendChild(el('li', {}, 'Tap a tray domino to rotate it.'));
  controls.appendChild(el('li', {}, 'Tap a placed domino to lock it in (thick black border). Tap again to unlock.'));
  controls.appendChild(el('li', {}, '“Clear” returns unlocked dominoes to the tray. Tap it again to clear locked ones too.'));
  controls.appendChild(el('li', {}, 'Each domino in the tray is unique — there’s exactly one solution.'));
  card.appendChild(controls);

  const ok = el('button', { type: 'button', class: 'instructions-ok' }, 'Got it');
  ok.addEventListener('click', hide);
  card.appendChild(ok);

  const o = el('div', { class: 'instructions-overlay', 'aria-hidden': 'true' });
  o.appendChild(card);
  // Click on the dim background dismisses; clicks inside the card don't.
  o.addEventListener('click', (ev) => { if (ev.target === o) hide(); });
  document.body.appendChild(o);
  return o;
}

export function showInstructions() {
  if (!overlay) overlay = build();
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

export function hide() {
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}
