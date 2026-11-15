// memory-pages: 64
// One counted heap shared by every class (R1b, D39's shared size classes): 256 KiB of pages, 3,000 objects of one class
// made and dropped, then 3,000 of another class the same size, made while the first are freed. The second class takes
// the first's slots, so it fits. With a pool per class (R1's design) the second class can't use what the first freed,
// and runs out (trap 14). Objects of a class twice the size go in a size class of their own, beside the small ones.
import { toU64, type u32, type u64 } from "@tsl/core";
import { rcCollect, rcLive } from "@tsl/gc";

class A {
  next: A | null = null;
  constructor(public v: u32) {}
}

class B {
  next: B | null = null;
  constructor(
    public w: u32,
    public x: u32,
  ) {}
}

class Big {
  next: Big | null = null;
  a: u64 = 0n;
  b: u64 = 0n;
  c: u64 = 0n;
  constructor(public v: u32) {}
}

let as: A | null = null;
let bs: B | null = null;

/** n A's at once, all dropped, then n B's at once: the B's live in the A's slots. Nothing left after. */
export function swap(n: u32): u32 {
  for (let i: u32 = 0; i < n; i++) {
    const a = new A(i);
    a.next = as;
    as = a;
  }
  let s: u32 = 0;
  for (let p = as; p !== null; p = p.next) s += p.v;
  as = null;
  for (let i: u32 = 0; i < n; i++) {
    const b = new B(i, 2);
    b.next = bs;
    bs = b;
  }
  for (let p = bs; p !== null; p = p.next) s += p.w + p.x;
  bs = null;
  rcCollect();
  return s * 10 + (rcLive() === 0 ? 0 : 1);
}

/** The swap again and again: the same slots go from one class to the other and back. */
export function swaps(rounds: u32, n: u32): u32 {
  let s: u32 = 0;
  for (let r: u32 = 0; r < rounds; r++) s = swap(n);
  return s;
}

/**
 * Small objects and objects twice their size made in turn, both kept, then every field read back: each class's objects
 * fill their own size class, so neither overlaps the other's.
 */
export function mixed(n: u32): u64 {
  let small: A | null = null;
  let big: Big | null = null;
  for (let i: u32 = 0; i < n; i++) {
    const a = new A(i);
    a.next = small;
    small = a;
    const g = new Big(i);
    g.a = toU64(i) * 3n;
    g.b = toU64(i) * 5n + 1n;
    g.c = 0xffff_ffff_ffff_ffffn - toU64(i);
    g.next = big;
    big = g;
  }
  let s: u64 = 0n;
  for (let p = small; p !== null; p = p.next) s += toU64(p.v);
  for (let q = big; q !== null; q = q.next)
    s += q.a + q.b + (0xffff_ffff_ffff_ffffn - q.c) + toU64(q.v);
  return s;
}
