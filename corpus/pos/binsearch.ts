import { idiv, toI32, type i32, type u32, type usize } from "@tsl/core";

/** Returns the index, or -1. An isize would suit, but it isn't in M1's subset. */
export function find(a: Uint32Array, key: u32): i32 {
  let lo: usize = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = lo + idiv(hi - lo, 2);
    const v = a[mid]!;
    if (v === key) return toI32(mid);
    if (v < key) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

export function lowerBound(a: Uint32Array, key: u32): usize {
  let lo: usize = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = lo + idiv(hi - lo, 2);
    if (a[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
