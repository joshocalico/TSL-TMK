// memory-pages: 32
// R35 (SPEC 4.4, D80): a value split around a cold call (R30) is stored before it and loaded back after it only where it's
// live after it: read later in the call's block, or live out of the block (a later block both ways join at, the next turn
// of a loop). An interval has no holes, so it can span a cold call on a way that never reads it again, and that way saves
// nothing now. Here: values read only where the ways join, a value one way reads after its call and another way doesn't,
// values carried round a loop past a call taken one turn in k, and floats across a cold call. Every answer is V8's, at
// every level. Under R35's `r35-save-block-only` bug (live after the call only where its own block reads it) a value read
// only where the ways join, or on the next turn, comes back as whatever the call left in its register.
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
  for (let i: i32 = 0; i < 7; i++) {
    x = x * 1.5 + y;
    y = y - x * 0.25;
  }
  return x + y;
}

/** Values made before a call taken one way only, read after it only where the two ways join. */
export function joinAfter(n: i32, k: i32): i32 {
  const a = (Math.imul(n, 7) + 3) | 0;
  const b = n ^ 0x5555;
  const c = (n + k) | 0;
  const d = (Math.imul(c, 13) - a) | 0;
  let r: i32 = 0;
  if (k === 1) r = churn(n, k, 5, 6);
  return (r ^ a ^ b ^ c ^ d) | 0;
}

/** One way returns its call's answer, needing nothing after it; another reads a value after its call. */
export function someWays(n: i32, k: i32): i32 {
  const a = (Math.imul(n, 7) + 3) | 0;
  const b = (n - 11) | 0;
  if (k === 1) return churn(n, k, 1, 2);
  if (k === 2) return (a + churn(n, 0, 3, 4) + b) | 0;
  return (a ^ b) | 0;
}

/** Values carried round a loop past a call taken one turn in `every`, read on the next turn. */
export function loopCold(n: i32, every: i32): i32 {
  let x: i32 = 1;
  let y: i32 = 2;
  let z: i32 = n;
  for (let i: i32 = 0; i < n; i++) {
    if (i % every === 0) y = (y + churn(x, y, i, n)) | 0;
    x = (Math.imul(x, 3) + y) | 0;
    z = (z ^ x) | 0;
  }
  return (x ^ y ^ z) | 0;
}

/** Floats across a cold call, read where the ways join. */
export function floats(n: i32, k: i32): i32 {
  const p = toF64(n) * 0.5;
  const q = toF64(n) + 0.25;
  let r = 0.0;
  if (k === 1) r = fchurn(p, q);
  return toI32(Math.trunc((r + p * q) % 1000000));
}
