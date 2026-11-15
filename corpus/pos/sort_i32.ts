import { idiv, type i32, type usize } from "@tsl/core";

export function insertion(a: Int32Array): void {
  for (let i: usize = 1; i < a.length; i++) {
    const key = a[i]!;
    let j = i;
    while (j > 0 && a[j - 1]! > key) {
      a[j] = a[j - 1]!;
      j--;
    }
    a[j] = key;
  }
}

function swap(a: Int32Array, i: usize, j: usize): void {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}

function partition(a: Int32Array, lo: usize, hi: usize): usize {
  const pivot = a[idiv(lo + hi, 2)]!;
  let i = lo;
  let j = hi;
  for (;;) {
    while (a[i]! < pivot) i++;
    while (a[j]! > pivot) j--;
    if (i >= j) return j;
    swap(a, i, j);
    i++;
    j--;
  }
}

function quickRange(a: Int32Array, lo: usize, hi: usize): void {
  if (lo >= hi) return;
  const p = partition(a, lo, hi);
  quickRange(a, lo, p);
  quickRange(a, p + 1, hi);
}

export function quick(a: Int32Array): void {
  if (a.length > 1) quickRange(a, 0, a.length - 1);
}

export function isSorted(a: Int32Array): i32 {
  for (let i: usize = 1; i < a.length; i++) {
    if (a[i - 1]! > a[i]!) return 0;
  }
  return 1;
}
