// User code between collector steps (SPEC 3.5, D41, D74), ported from the direct route's corpus/lower/rc/cyc_interleave.ts:
// the collector must never free a live object. Each function sets a budget of b with no pacing, so one allocation is b
// steps of the collector and `tick(k)` puts a change after k allocations: with b = 1, at every step there is. Each goes
// through every k in a range, and returns a digest that V8 as written has to agree with (where rcSetBudget and
// rcSetPacing do nothing that changes a result). An object freed while reachable traps 5 on the host's poisoned objects.
// A vector held by several objects is a holder object (`Arr`), and a closure over an object an environment (`Env`).
import { toU32, type bool, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCcFreed, rcCollect, rcSetBudget, rcSetPacing } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

const M: u32 = 1_000_003;

class C {
  next: C | null = null;
  other: C | null = null;
  peers: Arr | null = null;
  cb: Env | null = null;
  constructor(public v: u32) {}
}

class Arr {
  items = new Vec(ref<C>());
}

/** `(): u32 => c.v + 1`, held by `c`. */
class Env {
  constructor(
    public kind: u32,
    public self: C | null,
  ) {}
}

function call(e: Env): u32 {
  switch (e.kind) {
    case 0:
      return e.self!.v + 1;
    default:
      return 0;
  }
}

class Tick {
  constructor(public t: u32) {}
}

class Up {
  parent: Up | null = null;
  kids = new Vec(ref<Up>());
  constructor(public v: u32) {}
}

let _sink: Tick | null = null;
let g0: C | null = null;
let g1: C | null = null;
let gu: Up | null = null;

const SETTLE: u32 = 200;

function begin(budget: u32): void {
  rcSetBudget(budget);
  rcSetPacing(false);
}

function end(t: u32): u32 {
  rcSetBudget(RC_BUDGET);
  rcSetPacing(true);
  return t;
}

function tick(k: u32): void {
  for (let i: u32 = 0; i < k; i++) _sink = new Tick(i);
}

function mix(t: u32, x: u32): u32 {
  return (t * 31 + x) % M;
}

function ring(len: u32, seed: u32): C {
  const first = new C(seed);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const r = new C(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}

function sum(c: C | null, steps: u32): u32 {
  let t: u32 = 0;
  let p = c;
  for (let i: u32 = 0; i < steps && p !== null; i++) {
    t = (t * 3 + p.v) % M;
    p = p.next;
  }
  return t;
}

/** A ring with a holder dropped and re-held at k: a candidate, still held through another member. */
export function heldThroughout(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = ring(5, k);
    g1 = g0.next;
    g0 = null;
    tick(k);
    t = mix(t, sum(g1, 7));
    tick(k >>> 1);
    t = mix(t, sum(g1, 3));
    g1 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** The only holder moves to another at step k: a count taken before the old one goes. */
export function holderMoves(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = ring(6, k);
    g1 = g0.next!.next;
    g0 = null;
    tick(k);
    g0 = g1!.next;
    g1 = null;
    tick(k);
    t = mix(t, sum(g0, 8));
    g0 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** A garbage-looking ring made reachable again from a candidate: an edge from something a scan has been through. */
export function reachableAgain(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    const a = ring(4, k);
    const b = ring(4, k + 100);
    g0 = a;
    g1 = b;
    g1 = null;
    tick(k);
    a.other = b;
    tick(k);
    t = mix(t, sum(a.other, 5));
    g0 = null;
    tick(SETTLE);
    t = mix(t, sum(a, 2) + sum(b, 2));
  }
  return end(t);
}

/** An edge taken out of a scanned object into a holder at k, then the rest dropped. */
export function edgeTakenOut(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    const a = ring(3, k);
    a.other = ring(3, k + 50);
    g0 = a;
    tick(k);
    g1 = a.other;
    a.other = null;
    g0 = null;
    tick(k);
    t = mix(t, sum(g1, 4));
    g1 = null;
    tick(SETTLE);
    t = mix(t, a.v);
  }
  return end(t);
}

/** A holder taken and let go of at every step of the scan, walking the ring. */
export function flickering(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = ring(7, k);
    g1 = g0;
    g0 = null;
    for (let i: u32 = 0; i < k; i++) {
      g0 = g1;
      tick(1);
      g1 = g0!.next;
      g0 = null;
      tick(1);
    }
    t = mix(t, sum(g1, 9));
    g1 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** A held reference taken to a member of a ring while the ring is being scanned, and the ring's holder let go. */
export function heldDuringScan(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = ring(9, k);
    g1 = g0;
    g0 = null; // a candidate: the scan starts on it from here
    tick(k);
    g0 = g1!.next!.next!.next; // a member, held while the scan is under way
    g1 = null;
    tick(k >>> 1);
    t = mix(t, sum(g0, 10));
    g0 = null;
    tick(SETTLE);
  }
  return end(t);
}

function peers(n: u32, seed: u32): Arr {
  const a = new Arr();
  for (let i: u32 = 0; i < n; i++) {
    const c = new C(seed + i);
    c.peers = a;
    a.items.push(c);
  }
  return a;
}

/** Elements moved inside a vector a scan is partway through: moved up, one can be read twice. */
export function movedWhileScanned(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = peers(12, k).items.get(3); // the vector's last holders are its members
    g1 = g0.peers!.items.get(6);
    tick(k);
    // Inserting moves everything from 1 up by one, and taking it out moves it back. Neither changes their counts.
    const ps = g0.peers!;
    ps.items.insert(1, new C(1000 + k));
    tick(k >>> 2);
    ps.items.removeAt(1);
    tick(k >>> 2);
    const first = ps.items.removeAt(0);
    tick(k >>> 2);
    ps.items.push(first);
    g0 = null;
    tick(k >>> 1);
    const qs = g1!.peers!;
    t = mix(t, g1!.v + toU32(qs.items.length));
    for (let i: usize = 0; i < qs.items.length; i++) t = mix(t, qs.items.get(i).v);
    g1 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** A closure over an object, called, kept and let go of at k. */
export function closureCalled(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    const c = new C(k);
    c.cb = new Env(0, c);
    g0 = c;
    tick(k);
    t = mix(t, call(g0.cb!));
    const f = g0.cb!;
    g0 = null;
    tick(k);
    t = mix(t, call(f));
    tick(SETTLE);
    t = mix(t, c.v);
  }
  return end(t);
}

/** A closure kept alone, its object's every other holder gone: the closure keeps the object. */
export function closureOutlives(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    g0 = new C(k);
    g0.cb = new Env(0, g0);
    g1 = new C(0);
    g1.cb = g0.cb;
    g0 = null; // the object is held by its own closure, and the closure by g1
    tick(k);
    t = mix(t, call(g1.cb!));
    g1 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** A subtree cut out of a tree whose nodes point at their parents: it goes, and the tree it still points into stays. */
export function subtreeCut(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    const r = new Up(k);
    for (let i: u32 = 0; i < 4; i++) {
      const u = new Up(i);
      u.parent = r;
      r.kids.push(u);
      const w = new Up(i * 2);
      w.parent = u;
      u.kids.push(w);
    }
    gu = r;
    r.kids.pop();
    tick(k);
    t = mix(t, toU32(gu.kids.length) + gu.kids.get(0).kids.get(0).parent!.parent!.v);
    gu = null;
    tick(SETTLE);
    t = mix(t, toU32(r.kids.length));
  }
  return end(t);
}

/** A subtree cut while held only from below: a grandchild kept, its parent and the parent's parent cut out. */
export function heldFromBelow(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    gu = new Up(k);
    for (let i: u32 = 0; i < 3; i++) {
      const u = new Up(i + 10);
      u.parent = gu;
      for (let j: u32 = 0; j < 2; j++) {
        const w = new Up(j + 20);
        w.parent = u;
        u.kids.push(w);
      }
      gu.kids.push(u);
    }
    const leaf = gu.kids.get(1).kids.get(0);
    gu = null; // the whole tree is garbage-looking, but `leaf` reaches its parent and the root
    tick(k);
    t = mix(t, leaf.v + leaf.parent!.v + leaf.parent!.parent!.v);
    t = mix(t, toU32(leaf.parent!.parent!.kids.length));
    tick(SETTLE);
  }
  return end(t);
}

/** Everything at once: more rings than the scan takes in one go, some of them kept. */
export function several(budget: u32, from: u32, to: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  for (let k = from; k < to; k++) {
    const keep = ring(3, k);
    for (let i: u32 = 0; i < 4; i++) {
      const r = ring(3 + i, i);
      if (i === 2) keep.other = r;
    }
    g0 = keep;
    tick(k);
    t = mix(t, sum(g0.other, 6));
    g0 = null;
    tick(SETTLE);
    t = mix(t, keep.v);
  }
  return end(t);
}

/** Rings dropped, n of them of len, then everything collected: the cycle collector's count of what it freed. */
export function ccFreedRings(budget: u32, n: u32, len: u32): u32 {
  begin(budget);
  rcCollect();
  const f0: usize = rcCcFreed();
  for (let i: u32 = 0; i < n; i++) {
    g0 = ring(len, i);
    g0 = null;
  }
  tick(SETTLE);
  rcCollect();
  return end(toU32(rcCcFreed() - f0));
}

/** Rings dropped while one is kept: what the collector freed, less than all of them. */
export function ccFreedPartly(budget: u32, n: u32): u32 {
  begin(budget);
  rcCollect();
  const f0: usize = rcCcFreed();
  for (let i: u32 = 0; i < n; i++) {
    const r = ring(4, i);
    const keep: bool = i === 3;
    if (keep) g1 = r;
  }
  tick(SETTLE);
  rcCollect();
  const freed = toU32(rcCcFreed() - f0);
  g1 = null;
  return end(freed);
}

export function last(): u32 {
  g0 = null;
  g1 = null;
  gu = null;
  _sink = null;
  return 0;
}
