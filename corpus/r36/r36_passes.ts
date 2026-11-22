// memory-pages: 32
// R36 (SPEC 4.3, D44, D46): the optimiser's compile time cut with its output byte for byte as before. LICM makes a function's
// graph and loops again only after a loop has had something moved out of it; value numbering's tables are kept by value
// number in arrays made for each function. Here: loops one after another and one inside another, the first with something
// to move out (so a preheader is made, and every block after it moves along one), the later ones writing what they read on
// every turn; a loop inside a loop entered two ways, so its preheader is made in the outer loop; and functions alike but for
// their constants, so a value numbered as one function's constant isn't taken for another's. Every answer is V8's, at every
// level. Under R36's `r36-licm-stale` bug (the graph and loops kept after a loop had something moved out) the outer loop
// doesn't see the preheader made in it, and moves out what uses the preheader's values, which the optimiser's verifier
// refuses (doLoops); under `r36-constkeys-shared` (value numbering's constant table kept from one function to the next)
// values of one function are taken as another's constants, and the answers are wrong.
import { toUsize, type i32 } from "@tsl/core";

const G = new Int32Array(16);
const H = new Int32Array(16);

/** A loop with an invariant product to move out, then one that writes the element it reads on every turn. */
export function twoLoops(a: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) s = (s + Math.imul(a, 977) + i) | 0;
  const g = G;
  g[0] = 1;
  for (let i: i32 = 0; i < n; i++) {
    const v: i32 = g[0]!;
    g[0] = (Math.imul(v, 3) + 1) | 0;
    s = (s ^ v) | 0;
  }
  return s;
}

/** Three loops in a row, each of the first two with something to move out, the last reading what it writes. */
export function threeLoops(a: i32, b: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) s = (s + Math.imul(a, b) + i) | 0;
  for (let i: i32 = 0; i < n; i++) s = (s ^ (Math.imul(b, 31) + i)) | 0;
  const h = H;
  h[1] = 7;
  h[2] = 0;
  for (let i: i32 = 0; i < n; i++) {
    const v: i32 = h[1]!;
    const w: i32 = h[2]!;
    h[1] = (v + w + 1) | 0;
    h[2] = (w + Math.imul(v, 5)) | 0;
    s = (s + v - w) | 0;
  }
  return s;
}

/** A loop inside a loop: the inner one's invariant moves out of it, then a loop after both reads what it writes. */
export function nested(a: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    for (let j: i32 = 0; j < n; j++) s = (s + Math.imul(a, i + 3) + j) | 0;
  }
  const g = G;
  g[3] = 2;
  for (let k: i32 = 0; k < n; k++) {
    const v: i32 = g[3]!;
    g[3] = (v + k + 1) | 0;
    s = (s + Math.imul(v, 7)) | 0;
  }
  return s;
}

/** Writes and reads by an index the loop moves along, after a loop with something to move out. */
export function walkAfter(a: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) s = (s + (a << 3) + i) | 0;
  const g = G;
  for (let j: i32 = 0; j < 16; j++) g[toUsize(j)] = j;
  for (let k: i32 = 1; k < 16; k++) {
    const prev: i32 = g[toUsize(k - 1)]!;
    g[toUsize(k)] = (g[toUsize(k)]! + prev + s) | 0;
  }
  let t: i32 = 0;
  for (let j: i32 = 0; j < 16; j++) t = (t ^ g[toUsize(j)]!) | 0;
  return t;
}

/** Functions alike but for their constants, each sharing its own repeated work. */
export function shapeA(x: i32, y: i32): i32 {
  const p = (Math.imul(x, 7) + 3) | 0;
  const q = (Math.imul(y, 11) + 5) | 0;
  const r = (Math.imul(x, 7) + 3) | 0;
  return (p ^ q ^ (r << 1)) | 0;
}

export function shapeB(x: i32, y: i32): i32 {
  const a = (x + y) | 0;
  const b = (Math.imul(a, 13) - 9) | 0;
  const c = (Math.imul(x, 13) + 2) | 0;
  const d = (Math.imul(y, 17) + 4) | 0;
  const e = (Math.imul(a, 13) - 9) | 0;
  return (b + c - d + (e << 2)) | 0;
}

export function shapeC(x: i32, y: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < 4; i++) {
    const u = (Math.imul(x, 19) + i) | 0;
    const v = (Math.imul(y, 23) + i) | 0;
    s = (s + u - v + Math.imul(x, 19)) | 0;
  }
  return s;
}

export function shapeD(x: i32, y: i32): i32 {
  const m = (x & 255) + 1;
  const n = (y & 127) + 2;
  const k1 = (Math.imul(m, 3) + Math.imul(n, 5)) | 0;
  const k2 = (Math.imul(m, 5) + Math.imul(n, 3)) | 0;
  const k3 = (Math.imul(m, 3) + Math.imul(n, 5)) | 0;
  return (k1 - k2 + (k3 >> 1)) | 0;
}

export function shapeE(x: i32, y: i32): i32 {
  const h = H;
  h[4] = x;
  h[5] = y;
  const a = (h[4]! + 6) | 0;
  h[4] = (a + 1) | 0;
  const b = (h[4]! + 6) | 0;
  const c = (h[5]! + 8) | 0;
  return (a ^ b ^ c) | 0;
}

/**
 * A loop whose own turn computes what's used after it, inside another loop and entered two ways: the inner one's product
 * moves out of it into a preheader made for it, which is in the outer loop, so what the outer loop does with the product
 * after the inner one stays in the outer loop.
 */
export function doLoops(a: i32, n: i32): i32 {
  let s: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    let j: i32 = 0;
    if (i > 2) j = 1;
    let t: i32 = 0;
    do {
      t = Math.imul(a, i + 3);
      j = j + 1;
    } while (j < 4);
    s = (s + Math.imul(t, t)) | 0;
  }
  return s;
}
