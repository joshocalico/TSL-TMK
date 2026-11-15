// memory-pages: 64
// Variable-length tails (D69) in a `manual` package: an object with a tail is one block at its real size, and unsafeFree
// gives it back at that size, so the heap reuses it for another object of the same size class, of any length. A churn of
// objects too big for 64 pages if their blocks weren't reused (a free at the fixed part's size would put each block on the
// wrong list) runs, and a reused block is zeroed again before its new owner sees it. The expected values are V8's.
import {
  tail,
  toI32,
  toU32,
  toUsize,
  u16,
  u32,
  u8,
  withTail,
  type i32,
  type usize,
} from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

class Blob {
  id: u32 = 0;
  data = tail(u8);
}

class Text {
  n: i32 = 0;
  units = tail(u16);
}

function blob(id: u32, n: u32): Blob {
  const b = withTail(toUsize(n), new Blob());
  b.id = id;
  return b;
}

/** k rounds of making a blob of n bytes, checking it's zeroed, filling it, and freeing it: the sum of what each held. */
export function churn(n: u32, k: u32): i32 {
  let total: i32 = 0;
  for (let j: u32 = 0; j < k; j++) {
    const b = blob(j, n);
    for (let i: usize = 0; i < b.data.length; i++) {
      if (b.data[i]! !== 0) total -= 1000000;
      b.data[i] = 0xa5;
    }
    total += toI32(b.data.length) + (b.id === j ? 1 : 0);
    // SAFETY: b is this loop's own, and isn't used again.
    unsafeFree(b);
  }
  return total;
}

/** Sizes that take turns, all freed and made again: each object keeps its own length and contents. */
export function mixed(k: u32): i32 {
  let bad: i32 = 0;
  for (let j: u32 = 0; j < k; j++) {
    const a = blob(j, 10 + (j % 7) * 50);
    const t = withTail(toUsize(3 + (j % 5) * 100), new Text());
    t.n = toI32(t.units.length);
    for (let i: usize = 0; i < a.data.length; i++) a.data[i] = 1;
    for (let i: usize = 0; i < t.units.length; i++) {
      if (t.units[i]! !== 0) bad++;
      t.units[i] = 0xffff;
    }
    const b = blob(j + 1, 400 - (j % 3) * 130);
    for (let i: usize = 0; i < b.data.length; i++) if (b.data[i]! !== 0) bad++;
    if (a.id !== j || toU32(a.data.length) !== 10 + (j % 7) * 50) bad++;
    if (t.n !== toI32(t.units.length)) bad++;
    // SAFETY: each is this loop's own, freed once, and not used after.
    unsafeFree(a);
    // SAFETY: as a.
    unsafeFree(t);
    // SAFETY: as a.
    unsafeFree(b);
  }
  return bad;
}

/** A tail of none, made and freed many times: its block is the fixed part's, rounded to 8. */
export function emptyTails(k: u32): i32 {
  let t: i32 = 0;
  for (let j: u32 = 0; j < k; j++) {
    const b = blob(j, 0);
    t += toI32(b.data.length) + 1;
    // SAFETY: b is this loop's own, and isn't used again.
    unsafeFree(b);
  }
  return t;
}
