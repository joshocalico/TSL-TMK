// R15: loops -O2 versions (SPEC 4.3, D44; M5's R15 record), each with cases where the guard holds and the fast copy runs,
// and cases where it must fail and the loop as it was runs, trapping where a check fires: a bound one past the length, a
// bound or a length the loop changes, two arrays of different lengths, a stride past the end, and arrays that are one
// array. And a test after a join, which only one way into the join answered (conds.ts at -O1 and -O2).
import { Trap, trap, type f64, type usize } from "@tsl/core";

/** a[b + i] for i < m: the guard is b + m <= a.length. */
export function sumFrom(a: Float64Array, b: usize, m: usize): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < m; i++) s += a[b + i]!;
  return s;
}

/** a[i * stride + b] for i < m, as matmul reads a column. */
export function sumStrided(a: Float64Array, stride: usize, b: usize, m: usize): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < m; i++) s += a[i * stride + b]!;
  return s;
}

/** Two arrays read at the same index: each check's guard is against its own array's length. */
export function dot(a: Float64Array, b: Float64Array, m: usize): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < m; i++) s += a[i]! * b[i]!;
  return s;
}

/** Writes through one array and reads through another, which may be the same array: each turn sees the last's write. */
function shiftInto(src: Float64Array, dst: Float64Array, m: usize): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < m; i++) {
    dst[i + 1] = src[i]! + 1;
    s += src[i]!;
  }
  return s;
}

/** The same, with source and destination one array. */
export function shiftSelf(a: Float64Array, m: usize): f64 {
  return shiftInto(a, a, m);
}

/** Two arrays. */
export function shiftAdd(src: Float64Array, dst: Float64Array, m: usize): f64 {
  return shiftInto(src, dst, m);
}

/**
 * A list whose length lives in `len[0]` and which the loop shortens every other turn: its own check (as `JsArray.get`'s,
 * a compare and a branch to a trap) reads the length each turn, which the loop writes.
 */
export function drain(data: Float64Array, len: Uint32Array, m: usize): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < m; i++) {
    if (i >= len[0]!) trap(Trap.Bounds);
    s += data[i]!;
    if (i % 2 === 1) len[0] = len[0]! - 1;
  }
  return s;
}

/** A loop whose bound the loop raises: `i < n[0]`, with n[0] one more on every third turn. */
export function grow(data: Float64Array, n: Uint32Array): f64 {
  let s: f64 = 0;
  for (let i: usize = 0; i < n[0]!; i++) {
    s += data[i]!;
    if (i % 3 === 2) n[0] = n[0]! + 1;
  }
  return s;
}

/** A test after a join, which one way in answered and the other didn't: the check must stay. */
export function afterJoin(a: Float64Array, i: usize, bump: f64): f64 {
  let k: f64 = 0;
  if (i >= a.length) k = bump;
  return a[i]! + k;
}
