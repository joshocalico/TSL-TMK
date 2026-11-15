// memory-pages: 64
// corpus/rc/rc_shared.ts for lowered `rc` on the direct route (SPEC 3.5, D39, D41, R1e): 256 KiB of pages, 3,000 objects of
// one class made and dropped, then 3,000 of another class the same size, made while the first are freed. Walking a list
// leaves a count on each node it passes, so the nodes are the cycle collector's candidates (the class can be in a cycle),
// and a scan can take a node of a list that's being freed as a root. With one object freed an allocation, that node's
// count reaches zero during the scan: if the scan held it until it decided, the rest of the list would wait with it while
// the second class cut fresh blocks, and 64 pages would run out (trap 14).
class A {
  next: A | null = null;
  constructor(public v: number) {}
}

class B {
  next: B | null = null;
  constructor(public w: number) {}
}

class Big {
  next: Big | null = null;
  a = 0;
  b = 0;
  c = 0;
  constructor(public v: number) {}
}

let as: A | null = null;
let bs: B | null = null;

/** n A's at once, all dropped, then n B's at once: the B's live in the A's blocks. */
export function swap(n: number): number {
  for (let i = 0; i < n; i++) {
    const a = new A(i);
    a.next = as;
    as = a;
  }
  let s = 0;
  for (let p = as; p !== null; p = p.next) s += p.v;
  as = null;
  for (let i = 0; i < n; i++) {
    const b = new B(i);
    b.next = bs;
    bs = b;
  }
  for (let p = bs; p !== null; p = p.next) s += p.w + 2;
  bs = null;
  return s;
}

/** The swap again and again: the same blocks go from one class to the other and back. */
export function swaps(rounds: number, n: number): number {
  let s = 0;
  for (let r = 0; r < rounds; r++) s = swap(n);
  return s;
}

/** Small objects and objects twice their size made in turn, both kept, then every field read back. */
export function mixed(n: number): number {
  let small: A | null = null;
  let big: Big | null = null;
  for (let i = 0; i < n; i++) {
    const a = new A(i);
    a.next = small;
    small = a;
    const g = new Big(i);
    g.a = i * 3;
    g.b = i * 5 + 1;
    g.c = 1000000 - i;
    g.next = big;
    big = g;
  }
  let s = 0;
  for (let p = small; p !== null; p = p.next) s += p.v;
  for (let q = big; q !== null; q = q.next) s += q.a + q.b + (1000000 - q.c) + q.v;
  return s;
}
