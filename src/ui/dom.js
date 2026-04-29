// Tiny DOM helper.

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = String(dv);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else e.appendChild(c);
  }
  return e;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
