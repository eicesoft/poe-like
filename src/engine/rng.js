// Deterministic RNG (mulberry32) — works in browser and Node.
export class RNG {
  constructor(seed = 1 >>> 0) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  int(a, b) {
    // inclusive
    return Math.floor(this.range(a, b + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p) {
    return this.next() < p;
  }
  weighted(items) {
    let total = 0;
    for (const it of items) total += typeof it === 'number' ? it : it.weight;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      const w = typeof items[i] === 'number' ? items[i] : items[i].weight;
      r -= w;
      if (r <= 0) return typeof items[i] === 'number' ? i : items[i];
    }
    return items[items.length - 1];
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  fork(extra = 0) {
    return new RNG((this.s ^ (0x9e3779b9 + extra)) >>> 0);
  }
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}