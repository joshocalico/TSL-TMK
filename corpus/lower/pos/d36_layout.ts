// R6: D36 moved to TSL's own layout (D62's ruling): a bool is a byte, an optional scalar a bool flag and then its value at
// its own alignment, and an object's size its fields' rounded up to its alignment. These objects cross to the native
// caller as arguments and results, so the caller's reads and writes at the published offsets are tested with the module's
// own: bools side by side and between wider fields, an object of bools only (3 bytes), optional scalars of each width, and
// arrays of booleans and of objects whose size isn't a multiple of 8.
type Flags = { a: boolean; b: boolean; c: boolean };
type Mixed = { on: boolean; n: number; off: boolean; k: number; last: boolean };
type Maybe = { i?: number; f?: number; b?: boolean; id: number };
type Small = { x: number; y: number; z: number };

export function flags(n: number): Flags {
  return { a: (n & 1) !== 0, b: (n & 2) !== 0, c: (n & 4) !== 0 };
}

export function flagBits(f: Flags): number {
  return (f.a ? 1 : 0) + (f.b ? 2 : 0) + (f.c ? 4 : 0);
}

export function flip(f: Flags): Flags {
  f.b = !f.b;
  return f;
}

export function mixed(n: number, k: number): Mixed {
  return { on: n > 0, n: n * 0.5, off: n < 0, k: k | 0, last: (k & 1) === 1 };
}

export function mixedSum(m: Mixed): number {
  return (m.on ? 1 : 0) + m.n + (m.off ? 10 : 0) + m.k + (m.last ? 100 : 0);
}

export function maybe(n: number): Maybe {
  const m: Maybe = { id: n | 0 };
  if ((n & 1) !== 0) m.i = (n * 3) | 0;
  if ((n & 2) !== 0) m.f = n / 4;
  if ((n & 4) !== 0) m.b = (n & 8) !== 0;
  return m;
}

export function maybeSum(m: Maybe): number {
  return m.id + (m.i ?? -1) + (m.f ?? -2) + (m.b === undefined ? -4 : m.b ? 8 : 16);
}

export function smalls(n: number): Small[] {
  const out: Small[] = [];
  for (let i = 0; i < (n | 0); i++) out.push({ x: i | 0, y: (i * 2) | 0, z: (i * 3) | 0 });
  return out;
}

export function smallSum(xs: Small[]): number {
  let t = 0;
  for (const s of xs) t = (t + s.x + s.y + s.z) | 0;
  return t;
}

export function bools(n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < (n | 0); i++) out.push(i % 3 === 0);
  return out;
}

export function countTrue(xs: boolean[]): number {
  let t = 0;
  for (const x of xs) if (x) t++;
  return t;
}
