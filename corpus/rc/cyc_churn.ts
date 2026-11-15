// memory-pages: 96
// Far more cyclic garbage made and dropped than 96 pages hold, with a small live set (SPEC 3.5, D41, D74), ported from the
// direct route's corpus/lower/rc/cyc_churn.ts. With the cycle collector off each of these traps 14 under this limit, as a
// cycle's objects keep each other; with it on each completes, with the same result as V8 as written. A closure that
// captures `this` or an array can't be stored in TSL proper (TSL3003), so those are environment classes with a kind tag,
// referring back to their holder, and a call switch.
import { toU32, type u32 } from "@tsl/core";
import { rcSetWalk } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

const M: u32 = 1_000_003;

class Self {
  me: Self | null = null;
  constructor(public v: u32) {}
}

class Two {
  other: Two | null = null;
  constructor(public v: u32) {}
}

class RingNode {
  next: RingNode | null = null;
  constructor(public v: u32) {}
}

class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: u32) {}
}

/** `(): u32 => this.k` as an environment: what it captured is its box. */
class BoxEnv {
  constructor(
    public kind: u32,
    public self: Box | null,
  ) {}
}

class Box {
  op: BoxEnv | null = null;
  constructor(public k: u32) {}

  /** Not in the constructor: `this` isn't counted until `new` has made it, so it can't be shared from there. */
  bind(): void {
    this.op = new BoxEnv(0, this);
  }
}

function callBox(e: BoxEnv): u32 {
  switch (e.kind) {
    case 0:
      return e.self!.k;
    default:
      return e.self!.k + 1;
  }
}

/** `(): u32 => a.length + j`, held in `a`: the environment holds the array's holder and `j`. */
class ArrEnv {
  constructor(
    public kind: u32,
    public arr: Closures | null,
    public j: u32,
  ) {}
}

class Closures {
  fns = new Vec(ref<ArrEnv>());
}

function callArr(e: ArrEnv): u32 {
  switch (e.kind) {
    case 0:
      return toU32(e.arr!.fns.length) + e.j;
    default:
      return e.j;
  }
}

class Tree {
  parent: Tree | null = null;
  kids = new Vec(ref<Tree>());
  constructor(public v: u32) {}
}

let gRing: RingNode | null = null;

/** A node holding itself. */
export function selfLoops(n: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const s = new Self(i);
    s.me = s;
    t = (t + s.me.v) % M;
  }
  return t;
}

/** Two nodes holding each other. */
export function twoNodes(n: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const a = new Two(i);
    const b = new Two(i + 1);
    a.other = b;
    b.other = a;
    t = (t + a.other.v) % M;
  }
  return t;
}

function ring(len: u32, seed: u32): RingNode {
  const first = new RingNode(seed);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const r = new RingNode(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}

/** Rings of `len` nodes, each dropped as a whole. */
export function rings(n: u32, len: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const r = ring(len, i);
    t = (t + r.next!.v) % M;
  }
  return t;
}

/** Doubly linked lists: every neighbouring pair is a two-node cycle. */
export function doublyLinked(n: u32, len: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const head = new Link(i);
    let last = head;
    for (let j: u32 = 1; j < len; j++) {
      const c = new Link(j);
      c.prev = last;
      last.next = c;
      last = c;
    }
    t = (t + last.prev!.v) % M;
  }
  return t;
}

/** An object holding a closure over `this`: the box and its environment hold each other. */
export function thisClosures(n: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const b = new Box(i);
    b.bind();
    t = (t + callBox(b.op!)) % M;
  }
  return t;
}

/** Closures in an array, each capturing the array: the holder and every environment are one cycle. */
export function closuresInArrays(n: u32, m: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const a = new Closures();
    for (let j: u32 = 0; j < m; j++) {
      const e = new ArrEnv(0, a, j);
      a.fns.push(e);
    }
    t = (t + callArr(a.fns.get(0))) % M;
  }
  return t;
}

function tree(depth: u32, v: u32): Tree {
  const r = new Tree(v);
  if (depth > 0) {
    for (let i: u32 = 0; i < 2; i++) {
      const k = tree(depth - 1, v + i);
      k.parent = r;
      r.kids.push(k);
    }
  }
  return r;
}

/** Binary trees whose nodes point at their parents, children in a vector. */
export function parentTrees(n: u32, depth: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const r = tree(depth, i);
    t = (t + toU32(r.kids.length) + r.kids.get(0).parent!.v) % M;
  }
  return t;
}

/** A ring reachable only from a module global, then the global cleared. */
export function viaGlobal(n: u32, len: u32): u32 {
  rcSetWalk(false); // a cycle has to go before exhaustion would need the heap walk (R1d)
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    gRing = ring(len, i);
    t = (t + gRing.next!.v) % M;
    gRing = null;
  }
  return t;
}
