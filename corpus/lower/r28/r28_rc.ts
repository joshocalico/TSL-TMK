// R28 (SPEC 3.5, 4.3, D78): what R28's changes rest on, each where a wrong rule gives another answer than V8's:
// - a module variable written only once at the start (a string literal's) given to a call borrowed, and one a call
//   overwrites while its old value is an argument, which must stay alive for that call (the init-only rule);
// - objects and arrays made fresh, kept, of many sizes, so slots are cut in line across many pages (pageCut);
// - objects of several classes holding each other and arrays, freed, so each release function gets its object (untagged
//   references, callRelease's arms);
// - arrays grown and cut and grown again, so a reused slot's tail must read as zeroed holes (placeTail's zeroing in line);
// - a test of one constant index above another's read (dominating conditions on constants);
// - views of an appended string scanned to, and one past, their length (a second versioning pass after unswitching).
class Box {
  constructor(public v: number) {}
}

class Pair {
  constructor(
    public a: Box,
    public b: Box | null,
  ) {}
}

class Holder {
  items: Box[] = [];
  pair: Pair | null = null;
}

let shared = new Box(5);
const kept: Box[][] = [];
const keptPairs: Pair[] = [];

function swapShared(old: Box, k: number): number {
  shared = new Box(k);
  // allocations free what's waiting, which is where an old value with no count of its own would go
  let s = 0;
  for (let i = 0; i < 40; i++) s += new Box(i).v;
  return old.v * 1000 + shared.v + (s & 1);
}

/** The module variable overwritten by the call it's given to: its old value must last the call. */
export function overwriteWhileBorrowed(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const r = swapShared(shared, i + 1);
    t = (t + r) | 0;
  }
  return t;
}

/** Literals read in a loop, given to calls that make strings. */
export function literals(n: number): number {
  let s = "";
  for (let i = 0; i < (n | 0); i++) s += "xyz-"[i & 3]! + (i % 3 === 0 ? "ab" : "c");
  let t = s.length;
  for (let i = 0; i < s.length; i++) t = (t * 7 + s.charCodeAt(i)) | 0;
  return t;
}

/** Arrays of n objects each, made and kept: every slot fresh, across pages. */
export function freshKept(n: number, m: number): number {
  let t = 0;
  for (let j = 0; j < (m | 0); j++) {
    const xs: Box[] = [];
    for (let i = 0; i < (n | 0) + j; i++) xs.push(new Box(i * 3 + j));
    kept.push(xs);
    t = (t + xs[xs.length - 1]!.v + xs.length) | 0;
  }
  let u = 0;
  for (const xs of kept) for (const b of xs) u = (u + b.v) | 0;
  return (t * 31 + u) | 0;
}

/** Pairs and holders, made and dropped, and some kept: release functions of several classes. */
export function releaseMixed(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const h = new Holder();
    for (let k = 0; k < (i % 7) + 1; k++) h.items.push(new Box(k + i));
    h.pair = new Pair(new Box(i), i % 2 === 0 ? new Box(-i) : null);
    if (i % 5 === 0) keptPairs.push(h.pair);
    t = (t + h.items.length + h.pair.a.v + (h.pair.b !== null ? h.pair.b.v : 1)) | 0;
  }
  for (const p of keptPairs) t = (t + p.a.v) | 0;
  return t;
}

/** Grown, cut and grown again: what a longer length reaches reads as holes. */
export function regrowHoles(n: number): number {
  let t = 0;
  for (let r = 0; r < 4; r++) {
    const xs: (Box | null)[] = [];
    for (let i = 0; i < (n | 0) + r * 3; i++) xs.push(new Box(i + r));
    xs.length = 2;
    xs.length = (n | 0) + r;
    for (let i = 0; i < xs.length; i++) {
      const b = xs[i] ?? null;
      t = (t * 3 + (b === null ? 7 : b.v)) | 0;
    }
    const ys: number[] = [];
    for (let i = 0; i < (n | 0) * 2 + r; i++) ys.push(i);
    t = (t + ys.length + ys[ys.length - 1]!) | 0;
  }
  return t;
}

/** One constant index tested, another read: each check stays its own. */
export function constIndexes(n: number, i: number): number {
  const xs: number[] = [];
  for (let k = 0; k < (n | 0); k++) xs.push(k * 5 + 1);
  let t = 0;
  if (0 < xs.length) t += xs[2]!;
  if (1 < xs.length) t += xs[1]!;
  if (2 < xs.length) t += xs[3]!;
  return t + xs[i | 0]!;
}

/** A view of an appended string scanned to its length, or one past it (NaN, then 0). */
export function viewScan(n: number, past: number): number {
  let s = "";
  for (let i = 0; i < (n | 0); i++) s += "pqrs"[i & 3]!;
  const v = s.slice(1, s.length - 1);
  let t = 0;
  const end = v.length + (past | 0);
  for (let k = 0; k < 2; k++)
    for (let i = 0; i < end; i++) t = (t * 31 + (v.charCodeAt(i) | 0)) | 0;
  return t;
}

/**
 * Eight loops of checked reads, more than -O2's first versioning pass may copy in one function, so the second versions
 * what it left: each read is in range for m up to n, and m = n + 1 reads one past the end (the lowering's trap 2).
 */
export function manyLoops(n: number, m: number): number {
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < (n | 0); i++) {
    a.push(i);
    b.push(i * 2);
    c.push(i * 3);
    d.push(i * 5);
  }
  let t = 0;
  const k = m | 0;
  for (let i = 0; i < k; i++) t = (t * 3 + a[i]! * b[i]! + ((c[i]! ^ d[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 5 + b[i]! * c[i]! + ((d[i]! ^ a[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 7 + c[i]! * d[i]! + ((a[i]! ^ b[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 11 + d[i]! * a[i]! + ((b[i]! ^ c[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 13 + a[i]! * c[i]! + ((b[i]! ^ d[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 17 + b[i]! * d[i]! + ((a[i]! ^ c[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 19 + c[i]! * a[i]! + ((d[i]! ^ b[i]!) & 7)) | 0;
  for (let i = 0; i < k; i++) t = (t * 23 + d[i]! * b[i]! + ((c[i]! ^ a[i]!) & 7)) | 0;
  return t;
}
