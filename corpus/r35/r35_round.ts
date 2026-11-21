// memory-pages: 32
// R35 (SPEC 4.3, D44): -O1's check elimination in one round of range.ts, a loop header's parameters taken as anything
// their type allows. Here: loops whose values on the way in say less than they become (a counter compared with what it
// was at the start, a product that overflows on a later turn, an index that walks past a bound), tests above straight-line
// code that bound what it adds, subtracts and converts, a test that leaves one way unproved, and a float index tested into
// range. Every answer is V8's, at every level (the cases stop short of the traps, which V8 running the program as it is
// doesn't give). Under R35's `r35-round-header` bug (the header's parameters taken from the edges before the loop alone)
// `firstTurns` answers as if every turn were the first.
import { toF64, toI32, toU32, toUsize, type f64, type i32, type u32, type usize } from "@tsl/core";

/** A counter that is 0 on the way in: only its first turn takes the first way. */
export function firstTurns(n: i32): i32 {
  let k: i32 = 0;
  let acc: i32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    if (k < 1) acc = (acc + 100) | 0;
    else acc = (acc + 1) | 0;
    k = k + 1;
  }
  return acc;
}

/** A product, 1 on the way in, checked each turn (it would overflow i32 on the twentieth). */
export function grows(n: i32): i32 {
  let x: i32 = 1;
  for (let i: i32 = 0; i < n; i++) x = x * 3;
  return x;
}

const WALK = new Int32Array(8);
const READ = new Int32Array(16);

/** An index that starts in range and walks along it, its array's check kept: the cases stay in range. */
export function walk(n: i32, step: i32): i32 {
  const a = WALK;
  for (let j: i32 = 0; j < 8; j++) a[toUsize(j)] = j * 10;
  let i: i32 = 0;
  let s: i32 = 0;
  for (let t: i32 = 0; t < n; t++) {
    s = s + a[toUsize(i)]!;
    i = i + step;
  }
  return s;
}

/** What a test above bounds: the checked adds, the subtraction and the conversions below it can't fail, so they go. */
export function bounded(n: i32): i32 {
  if (n < 0) return -1;
  if (n > 1000) return -2;
  const u: usize = toUsize(n);
  const bytes: usize = 16 + u * 2 + 31;
  if (bytes <= 32) return 5;
  return toI32(32 - Math.clz32(toU32(bytes - 1)));
}

/** One way bounded and one not: the unbounded way keeps its check. */
export function halfBounded(a: i32, b: i32): i32 {
  if (a < 1000) return a + 1000;
  return a + b;
}

/** A float index tested into `[0, n)` and an integer (n at most 16), read through ToInt32. */
export function floatIndex(x: f64, n: i32): i32 {
  const a = READ;
  for (let j: i32 = 0; j < n; j++) a[toUsize(j)] = j + 1;
  if (x >= 0) {
    if (x < toF64(n)) {
      if (Math.trunc(x) === x) return a[toUsize(x | 0)]!;
    }
  }
  return -1;
}

/** Unsigned: a value tested below a constant, then multiplied, the multiply's check proved by the test. */
export function scaled(v: u32): u32 {
  if (v >= 0x1000) return 0;
  const w: u32 = v * 16;
  return w;
}
