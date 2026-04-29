// Stats panel rendering with a histogram of win times.

import { el, clear } from './dom.js';
import { computedStats, resetStats } from '../stats/storage.js';

const BINS = [
  { label: '<30s', max: 30_000 },
  { label: '30s–1m', max: 60_000 },
  { label: '1–2m', max: 120_000 },
  { label: '2–3m', max: 180_000 },
  { label: '3–5m', max: 300_000 },
  { label: '5–10m', max: 600_000 },
  { label: '10m+', max: Infinity },
];

export function renderStats(panel, onRequestNew) {
  clear(panel);
  const s = computedStats();

  panel.appendChild(el('h2', {}, 'Stats'));
  panel.appendChild(row('Wins', `${s.wins}`));
  panel.appendChild(row('Give-ups', `${s.giveUps}`));
  panel.appendChild(row('Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`));
  panel.appendChild(row('Avg win time', s.avgMs == null ? '—' : formatMs(s.avgMs)));
  panel.appendChild(row('Fastest win', s.fastestMs == null ? '—' : formatMs(s.fastestMs)));

  panel.appendChild(el('div', { class: 'histogram' }, histogramSvg(s.winTimesMs)));

  const actions = el('div', { class: 'stats-actions' });
  const reset = el('button', { type: 'button' }, 'Reset stats');
  reset.addEventListener('click', () => {
    if (confirm('Reset all stats? This cannot be undone.')) {
      resetStats();
      renderStats(panel, onRequestNew);
    }
  });
  actions.appendChild(reset);
  panel.appendChild(actions);
}

function row(label, value) {
  return el('div', { class: 'stat-row' }, el('span', {}, label), el('span', {}, value));
}

function histogramSvg(times) {
  const counts = BINS.map(() => 0);
  for (const t of times) {
    for (let i = 0; i < BINS.length; i++) if (t < BINS[i].max) { counts[i]++; break; }
  }
  const W = 280, H = 140;
  const pad = 24;
  const max = Math.max(1, ...counts);
  const barW = (W - 2 * pad) / BINS.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Axes.
  const axis = document.createElementNS(ns, 'line');
  axis.setAttribute('x1', pad);
  axis.setAttribute('y1', H - pad);
  axis.setAttribute('x2', W - pad);
  axis.setAttribute('y2', H - pad);
  axis.setAttribute('stroke', '#888');
  svg.appendChild(axis);

  for (let i = 0; i < BINS.length; i++) {
    const x = pad + i * barW + 2;
    const h = (counts[i] / max) * (H - 2 * pad);
    const y = H - pad - h;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', barW - 4);
    rect.setAttribute('height', h);
    rect.setAttribute('fill', '#b65b35');
    rect.setAttribute('rx', '2');
    svg.appendChild(rect);

    if (counts[i] > 0) {
      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', x + (barW - 4) / 2);
      txt.setAttribute('y', y - 2);
      txt.setAttribute('font-size', '10');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('fill', '#333');
      txt.textContent = counts[i];
      svg.appendChild(txt);
    }

    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', x + (barW - 4) / 2);
    lbl.setAttribute('y', H - pad + 12);
    lbl.setAttribute('font-size', '9');
    lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('fill', '#555');
    lbl.textContent = BINS[i].label;
    svg.appendChild(lbl);
  }

  return svg;
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}
