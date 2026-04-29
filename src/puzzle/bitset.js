// Bitset helpers for cell value domains (7 bits, values 0..6).

export const FULL_DOMAIN = 0b1111111; // all 7 values possible

export function bit(v) { return 1 << v; }
export function has(domain, v) { return (domain & (1 << v)) !== 0; }
export function add(domain, v) { return domain | (1 << v); }
export function remove(domain, v) { return domain & ~(1 << v); }

export function popcount(domain) {
  let c = 0;
  while (domain) { c += domain & 1; domain >>= 1; }
  return c;
}

export function singletonValue(domain) {
  // Returns the value if domain has exactly one bit, else -1.
  if (domain === 0 || (domain & (domain - 1)) !== 0) return -1;
  // exactly one bit
  for (let v = 0; v <= 6; v++) if (domain === (1 << v)) return v;
  return -1;
}

export function lowest(domain) {
  for (let v = 0; v <= 6; v++) if (domain & (1 << v)) return v;
  return -1;
}

export function highest(domain) {
  for (let v = 6; v >= 0; v--) if (domain & (1 << v)) return v;
  return -1;
}

export function values(domain) {
  const out = [];
  for (let v = 0; v <= 6; v++) if (domain & (1 << v)) out.push(v);
  return out;
}

// Clip mask for "value < n" (values strictly less than n, i.e. 0..n-1).
export function ltMask(n) {
  if (n <= 0) return 0;
  if (n > 6) return FULL_DOMAIN;
  return (1 << n) - 1;
}
// Clip mask for "value > n" (values strictly greater than n, i.e. n+1..6).
export function gtMask(n) {
  if (n >= 6) return 0;
  if (n < 0) return FULL_DOMAIN;
  return FULL_DOMAIN & ~((1 << (n + 1)) - 1);
}
