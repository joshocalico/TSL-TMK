// memory-pages: 32
// R30 (SPEC 4.4): values live across calls that run only on some turns of a loop, or on some ways through a function (cold
// calls). At -O1 and -O2 such a value may sit in a register a call clobbers, stored to its slot just before each cold call
// and loaded back just after (compiler/backend-aarch64/regalloc.ts's coldCalls). Here: many integers and floats across a
// call taken one turn in k, a function's own arguments across a cold call given other arguments, a cold call outside any
// loop, a hot call beside a cold one, and a caller whose own values sit in callee-saved registers across calls to all of
// these. Every answer is V8's, at every level.
import { toF64, toI32, type f64, type i32 } from "@tsl/core";

/** Clobbers every register a call may: a loop of its own, its arguments mixed. */
/** @tsl.noinline */
function churn(a: i32, b: i32, c: i32, d: i32): i32 {
  let x = a;
  let y = b;
  let z = c;
  let w = d;
  for (let i: i32 = 0; i < 9; i++) {
    x = (Math.imul(x, 31) + y) | 0;
    y = (y ^ z) + i;
    z = (z + Math.imul(w, 3)) | 0;
    w = (w - x) | 0;
  }
  return (x ^ y ^ z ^ w) | 0;
}

/** Clobbers float registers too. */
/** @tsl.noinline */
function fchurn(a: f64, b: f64): f64 {
  let x = a;
  let y = b;
  for (let i: i32 = 0; i < 5; i++) {
    x = x * 0.5 + y;
    y = y - x * 0.25;
  }
  return x + y;
}

/** Eight integers live across a call taken when i % k is 0, and used after it on every turn. */
/** @tsl.noinline */
export function many(n: i32, k: i32): i32 {
  let a: i32 = 1;
  let b: i32 = 2;
  let c: i32 = 3;
  let d: i32 = 4;
  let e: i32 = 5;
  let f: i32 = 6;
  let g: i32 = 7;
  let h: i32 = 8;
  let t: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    a = (a + i) | 0;
    b = (b ^ a) | 0;
    c = (c + Math.imul(b, 3)) | 0;
    d = (d - c) | 0;
    e = (e + (d >> 1)) | 0;
    f = (f ^ e) | 0;
    g = (g + f) | 0;
    h = (h - g) | 0;
    if (k > 0 && i % k === 0) t = (t + churn(a, b, c, d)) | 0;
    t = (t + a + b + c + d + e + f + g + h) | 0;
  }
  return t;
}

/** Floats across a cold call, with integers. */
/** @tsl.noinline */
export function floats(n: i32, k: i32): f64 {
  let x: f64 = 1.5;
  let y: f64 = -2.25;
  let z: f64 = 0.125;
  let s: f64 = 0;
  let m: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    x = x * 0.75 + toF64(i);
    y = y + x * 0.5;
    z = z - y * 0.125;
    m = (m + Math.imul(i, 3)) | 0;
    if (k > 0 && i % k === 0) s = s + fchurn(x, z);
    s = s + x - y + z + toF64(m);
  }
  return s;
}

/**
 * The function's own arguments, which come in the registers a call's arguments go in, live across a cold call given other
 * arguments: each must be the caller's again after it.
 */
/** @tsl.noinline */
export function args(p: i32, q: i32, r: i32, s: i32, k: i32): i32 {
  let t: i32 = 0;
  if (k === 1) t = churn(q, r, s, p);
  if (k === 2) t = churn(s, p, q, r);
  return (t + Math.imul(p, 1000003) + Math.imul(q, 10007) + Math.imul(r, 101) + s) | 0;
}

/** A cold call outside any loop, and a hot one: what's across the hot call keeps its callee-saved register. */
/** @tsl.noinline */
export function mixed(n: i32, k: i32): i32 {
  const base = Math.imul(n, 7919);
  const other = (n ^ 0x5555) | 0;
  let t = churn(base, other, n, k);
  if (k > 2) t = (t + churn(other, base, k, n)) | 0;
  return (t + base + other + n + k) | 0;
}

/** A caller whose values are across calls to every one of these: hot calls, so its values are in callee-saved registers. */
export function outer(n: i32, k: i32): i32 {
  const a = Math.imul(n, 3) + 1;
  const b = (n ^ 0x1234) | 0;
  const c = (k + 77) | 0;
  let t: i32 = 0;
  for (let i: i32 = 0; i < 4; i++) {
    t = (t + many(n, k + i) + a) | 0;
    t = (t + toI32(floats(n, k + i)) + b) | 0;
    t = (t + args(i, n, k, a, i % 3) + c) | 0;
    t = (t + mixed(n + i, k) + a + b + c) | 0;
  }
  return (t + a + b + c) | 0;
}
