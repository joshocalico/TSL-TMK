// memory-pages: 48
// R36 (SPEC 4.3, D44, D46): the optimiser's compile time cut with its output byte for byte as before, through the TSL route
// in `rc` with class printing, where a module carries @tsl/gc's and @tsl/jsrt's functions: hundreds of functions, many alike
// but for their constants and value numbers, many with loops one after another. Here: objects and arrays written and read
// back in loops after loops with something to move out, strings built and scanned, and a map counted; every answer is
// V8's, at every level. R36's `r36-constkeys-shared` gives wrong answers here natively through the TSL route.
class Cell {
  v: number;
  next: Cell | null;
  constructor(v: number, next: Cell | null) {
    this.v = v;
    this.next = next;
  }
}

function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

/** A list built, then walked twice: once summing, once writing each cell from the one after it. */
export function cells(n: number, k: number): number {
  let head: Cell | null = null;
  for (let i = 0; i < n; i++) head = new Cell(i * k + 1, head);
  let s = 0;
  for (let c = head; c !== null; c = c.next) s = mix(s, c.v);
  for (let c = head; c !== null; c = c.next) {
    const after = c.next;
    if (after !== null) c.v = c.v + after.v;
    s = mix(s, c.v);
  }
  return s;
}

/** An array filled after a loop with something to move out, then each element written from the one before it. */
export function prefix(n: number, a: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = (t + a * 977 + i) | 0;
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i + t);
  for (let i = 1; i < xs.length; i++) xs[i] = (xs[i]! + xs[i - 1]!) | 0;
  let h = 0;
  for (let i = 0; i < xs.length; i++) h = mix(h, xs[i]!);
  return h;
}

/** Strings joined and scanned, each turn's text read back by its units. */
export function texts(n: number, word: string): number {
  let s = "";
  for (let i = 0; i < n; i++) s += word + String(i % 10);
  let h = s.length;
  for (let j = 0; j < s.length; j++) h = mix(h, s.charCodeAt(j));
  return h;
}

/** Words counted in a map, then the counts read back in order. */
export function counts(n: number, m: number): number {
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = "k" + String(i % m);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let h = 0;
  for (const [key, c] of seen) h = mix(mix(h, key.length), c);
  return h;
}

/** Two objects' fields written in turn, each read back after the other's write. */
export function pairs(n: number): number {
  const a = new Cell(1, null);
  const b = new Cell(2, a);
  let s = 0;
  for (let i = 0; i < n; i++) {
    a.v = a.v + b.v;
    b.v = b.v + 1;
    s = mix(s, a.v + b.v);
  }
  return s;
}
