// memory-pages: 256
// R8 (SPEC 4.5's ABI in `rc`, D36, D39): counted objects crossing an export, through both routes. A native caller places
// what it passes (one count each, its own), retains each object it stores into another, and releases what it placed and
// every result after the call; an export borrows its arguments and gives its result with one count, the caller's. Object
// arguments and results, objects inside objects, nulls, a result that's an argument given back, an argument kept in module
// state and later given back or let go of, cycles the collector takes once the caller lets go, and a long list whose last
// count a caller gives back, freed a bounded number of steps at a time (D39).
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}

class Pair {
  left: Node | null = null;
  right: Node | null = null;
  tag = 0;
}

class Ring {
  next: Ring | null = null;
  constructor(public v: number) {}
}

let kept: Node | null = null;
let ring: Ring | null = null;

/** A new object, given to the caller. */
export function make(v: number): Node {
  return new Node(v);
}

/** A chain, a borrowed argument, which can be null. */
export function sum(n: Node | null): number {
  let t = 0;
  for (let p = n; p !== null; p = p.next) t += p.v;
  return t;
}

/** A new object holding two the caller placed: each held by the result as well as by the caller. */
export function pairOf(a: Node, b: Node | null): Pair {
  const p = new Pair();
  p.left = a;
  p.right = b;
  p.tag = (a.v + (b === null ? 0 : b.v)) | 0;
  return p;
}

/** Objects inside an object the caller placed. */
export function pairSum(p: Pair): number {
  return sum(p.left) * 1000 + sum(p.right) + p.tag;
}

/** An argument given back as the result: one more count, the caller's. */
export function same(n: Node): Node {
  n.v = n.v + 1;
  return n;
}

/** Either an object or null. */
export function maybe(v: number): Node | null {
  return v > 0 ? new Node(v) : null;
}

/** Keeps its argument in module state: the module's own count, past the caller's release. */
export function keep(n: Node): number {
  kept = n;
  return n.v;
}

/** What was kept, read in a later call. */
export function readKept(): number {
  return sum(kept);
}

/** The kept object given back, with a count of its own, and let go of by the module. */
export function takeKept(): Node | null {
  const k = kept;
  kept = null;
  return k;
}

/** A field of an argument set to a new object, which the caller's object then holds. */
export function attach(p: Pair, v: number): number {
  p.right = new Node(v);
  return p.right.v;
}

/** A ring of n: a cycle, which only the collector frees once nothing outside it holds it. */
export function cycle(n: number): Ring {
  const head = new Ring(0);
  let last = head;
  for (let i = 1; i < (n | 0); i++) {
    const r = new Ring(i);
    last.next = r;
    last = r;
  }
  last.next = head;
  return head;
}

/** Around a ring the caller holds. */
export function ringSum(r: Ring, steps: number): number {
  let t = 0;
  let p: Ring | null = r;
  for (let i = 0; i < (steps | 0) && p !== null; i++) {
    t += p.v;
    p = p.next;
  }
  return t;
}

/** A ring kept in module state, and let go of later. */
export function keepRing(n: number): number {
  ring = cycle(n);
  return ringSum(ring, n * 2);
}

export function dropRing(): number {
  ring = null;
  return 0;
}

/** A long list, whose last count the caller gives back: freed a step at a time, by later allocations (D39). */
export function longList(n: number): Node {
  let head = new Node(0);
  for (let i = 1; i < (n | 0); i++) {
    const x = new Node(i);
    x.next = head;
    head = x;
  }
  return head;
}

/** One allocation, which takes its share of the freeing waiting. */
export function one(v: number): number {
  const n = new Node(v);
  return n.v + 1;
}
