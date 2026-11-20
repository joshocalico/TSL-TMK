// memory-pages: 32
// R31 (SPEC 4.4): the cold-call split's quick ways out. At -O1 and -O2 a block that makes only the constants it returns is a
// quick way out, as an empty one was, so a call past `if (n === 0) return 0;` is on every way through that does the work and
// isn't cold. Here: functions with such a test before their call, integer and float, called from a loop; and values made
// before a loop and in it, across a call taken on most of its turns (a cold call, split around), with callees that clobber
// every register a call may. Every answer is V8's, at every level.
import { toF64, toI32, type f64, type i32 } from "@tsl/core";

/** Clobbers every register a call may: fourteen integers live at once, and as many floats. */
/** @tsl.noinline */
function churn(a: i32, b: i32): i32 {
  let x0 = a;
  let x1 = b;
  let x2 = (a ^ 3) | 0;
  let x3 = (b + 5) | 0;
  let x4 = (a - b) | 0;
  let x5 = Math.imul(a, 3);
  let x6 = Math.imul(b, 5);
  let x7 = (a + 11) | 0;
  let x8 = (b ^ 13) | 0;
  let x9 = (a - 17) | 0;
  let x10 = (b + 19) | 0;
  let x11 = (a ^ b) | 0;
  let x12 = (a + b) | 0;
  let x13 = (a - 29) | 0;
  for (let i: i32 = 0; i < 3; i++) {
    x0 = (x0 + x13) | 0;
    x1 = (x1 ^ x0) | 0;
    x2 = (x2 + x1) | 0;
    x3 = (x3 ^ x2) | 0;
    x4 = (x4 + x3) | 0;
    x5 = (x5 ^ x4) | 0;
    x6 = (x6 + x5) | 0;
    x7 = (x7 ^ x6) | 0;
    x8 = (x8 + x7) | 0;
    x9 = (x9 ^ x8) | 0;
    x10 = (x10 + x9) | 0;
    x11 = (x11 ^ x10) | 0;
    x12 = (x12 + x11) | 0;
    x13 = (x13 ^ x12) + i;
  }
  return (x0 ^ x1 ^ x2 ^ x3 ^ x4 ^ x5 ^ x6 ^ x7 ^ x8 ^ x9 ^ x10 ^ x11 ^ x12 ^ x13) | 0;
}

/** Clobbers float registers too. */
/** @tsl.noinline */
function fchurn(a: f64): f64 {
  let y0 = a;
  let y1 = a * 0.5;
  let y2 = a + 1.5;
  let y3 = a - 2.25;
  let y4 = a * 0.25;
  let y5 = a + 3.125;
  let y6 = a - 0.75;
  let y7 = a * 1.5;
  for (let i: i32 = 0; i < 3; i++) {
    y0 = y0 * 0.5 + y7;
    y1 = y1 - y0 * 0.25;
    y2 = y2 + y1;
    y3 = y3 * 0.5 - y2;
    y4 = y4 + y3 * 0.125;
    y5 = y5 - y4;
    y6 = y6 * 0.75 + y5;
    y7 = y7 * 0.5 - y6 * 0.0625;
  }
  return y0 + y1 + y2 + y3 + y4 + y5 + y6 + y7;
}

/** Six values made before the loop, each used on every turn after a call taken on all turns but every k-th. */
/** @tsl.noinline */
export function invariant(n: i32, k: i32): i32 {
  const p = Math.imul(n, 7) + 1;
  const q = (n ^ 0x2468) | 0;
  const r = (k + 99) | 0;
  const s = Math.imul(k, 13) - 5;
  const u = (p + q) | 0;
  const w = (r ^ s) | 0;
  let t: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    const own = (Math.imul(i, 3) + t) | 0;
    if (k <= 0 || i % k !== 0) t = (t + churn(own, i)) | 0;
    t = (t + p + q + r + s + u + w + own) | 0;
  }
  return (t + p + q + r + s + u + w) | 0;
}

/** Floats made before the loop, across a cold call inside it. */
/** @tsl.noinline */
export function invariantF(n: i32, k: i32): f64 {
  const a: f64 = toF64(n) * 0.5;
  const b: f64 = toF64(k) - 2.75;
  const c: f64 = a * b + 0.125;
  let s: f64 = 0;
  for (let i: i32 = 0; i < n; i++) {
    if (k <= 0 || i % k !== 0) s = s + fchurn(toF64(i));
    s = s + a - b + c;
  }
  return s + a + b + c;
}

/** A call past a quick way out that returns a constant: on every way through that does the work, so not cold. */
/** @tsl.noinline */
export function quick(x: i32, y: i32): i32 {
  if (x === 0) return 0;
  const m = Math.imul(x, y) | 0;
  const t = churn(x, y);
  return (t + m + x) | 0;
}

/** The same with a float constant, as JPEG's `receiveExtend` and `readBits` are. */
/** @tsl.noinline */
export function quickF(x: f64): f64 {
  if (x === 0) return 0;
  const m = x * 3;
  const t = fchurn(x);
  return t + m + x;
}

/** A caller of each from a loop, with its own values across those calls. */
export function outer(n: i32, k: i32): i32 {
  const a = Math.imul(n, 5) + 3;
  let t: i32 = 0;
  for (let i: i32 = 0; i < 6; i++) {
    t = (t + invariant(n + i, k) + a) | 0;
    t = (t + toI32(invariantF(n + i, k + i)) + a) | 0;
    t = (t + quick(i % 3, n) + quick(i, k)) | 0;
    t = (t + toI32(quickF(toF64(i % 2))) + toI32(quickF(toF64(i) + 0.5))) | 0;
  }
  return (t + a) | 0;
}
