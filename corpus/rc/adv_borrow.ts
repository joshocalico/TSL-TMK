// Borrows the expansion has to get right (SPEC 3.5, D39, D74), ported from the direct route's corpus/lower/rc/adv_*.ts: a
// callee clearing the only other holder of its own argument, reached through a global, a field and a vector element; a
// method whose receiver's only holder is cleared inside it; self-assignment and swaps; temporaries; and every way out of a
// scope. Each callee allocates after clearing, so a freed argument's slot would be reused under it: natively that reads
// another object's fields, and on the host a freed object is poisoned, so any use of it traps 5.
import { type bool, type u32 } from "@tsl/core";
import { rcCollect, rcLive } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class P {
  constructor(public x: u32) {}
}

class H {
  p: P | null = null;
  items = new Vec(ref<P>());
}

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}

  /** Clears its own only holder, then allocates: `this` must still be held by the caller. */
  dropSelf(): u32 {
    holder = null;
    return this.v + churn();
  }
}

let g: P | null = null;
let h: H | null = null;
let holder: Node | null = null;

function churn(): u32 {
  let s: u32 = 0;
  for (let i: u32 = 0; i < 64; i++) s += new P(i).x;
  return s;
}

function viaG(p: P): u32 {
  g = null;
  const c = churn();
  return p.x + c;
}

export function throughGlobal(n: u32): u32 {
  g = new P(n);
  return viaG(g);
}

function viaH(p: P): u32 {
  h!.p = null;
  const c = churn();
  return p.x + c;
}

export function throughField(n: u32): u32 {
  h = new H();
  h.p = new P(n);
  const r = viaH(h.p);
  h = null;
  return r;
}

function viaElement(p: P): u32 {
  const hh = h!;
  const old = hh.items.pop();
  const c = churn();
  return p.x + c + (old.x === p.x ? 1 : 0);
}

export function throughElement(n: u32): u32 {
  h = new H();
  h.items.push(new P(n));
  const r = viaElement(h.items.get(0));
  h = null;
  return r;
}

export function throughReceiver(n: u32): u32 {
  holder = new Node(n);
  return holder.dropSelf();
}

/** `o.next = o.next` and swaps: each store counts the new value before dropping the old. */
export function selfAssign(n: u32): u32 {
  const a = new Node(1);
  a.next = new Node(n);
  // oxlint-disable-next-line no-self-assign -- the self-assignment is what's tested
  a.next = a.next;
  const b = new Node(2);
  b.next = new Node(n + 1);
  const t = a.next;
  a.next = b.next;
  b.next = t;
  churn();
  return a.next!.v * 1000 + b.next!.v;
}

function make3(v: u32): Node {
  const n = new Node(v);
  n.next = new Node(v + 1);
  n.next.next = new Node(v + 2);
  return n;
}

function sumOf(n: Node | null): u32 {
  let s: u32 = 0;
  for (let p = n; p !== null; p = p.next) s += p.v;
  return s;
}

/** Owned values as arguments and receivers: temporaries dropped after their statement. */
export function temporaries(v: u32): u32 {
  rcCollect();
  const base = rcLive();
  const a = sumOf(make3(v));
  const b = make3(v + 10).next!.v;
  const c = sumOf(new Node(v));
  rcCollect();
  return (a * 100 + b) * 100 + c + (rcLive() === base ? 0 : 1_000_000);
}

/** Every way out of a scope: return from inside a loop, break, continue, and labelled break. */
export function exits(n: u32): u32 {
  rcCollect();
  const base = rcLive();
  let s: u32 = 0;
  outer: for (let i: u32 = 0; i < n; i++) {
    const a = new Node(i);
    for (let j: u32 = 0; j < 4; j++) {
      const b = new Node(j);
      if (j === 1) continue;
      if (j === 3) break;
      if (i === 7) break outer;
      s += a.v + b.v;
    }
  }
  const r = early(n);
  rcCollect();
  return s * 1000 + r + (rcLive() === base ? 0 : 500);
}

function early(n: u32): u32 {
  const keep = new Node(n);
  for (let i: u32 = 0; i < 10; i++) {
    const t = new Node(i);
    if (i === 5) return keep.v + t.v;
  }
  return 0;
}

/** A field returned is shared; a local returned is moved. */
function firstOf(n: Node): Node | null {
  return n.next;
}

function fresh(v: u32): Node {
  const n = new Node(v);
  return n;
}

function returnsIn(v: u32): bool {
  const a = fresh(v);
  a.next = fresh(v + 1);
  const f = firstOf(a);
  return f !== null && f.v === v + 1;
}

export function returns(v: u32): bool {
  rcCollect();
  const base = rcLive();
  const ok = returnsIn(v);
  rcCollect();
  return ok && rcLive() === base;
}

/** A local read from a global, then the global cleared: the local's region has a store, so it keeps its own count. */
export function regionStore(n: u32): u32 {
  g = new P(n);
  const p = g;
  g = null;
  const c = churn();
  return p.x + c;
}

/** A walk with no store in its region borrows, in a function that stores elsewhere. */
export function regionWalk(n: u32): u32 {
  holder = new Node(1);
  holder.next = new Node(n);
  let s: u32 = 0;
  for (let q: Node | null = holder; q !== null; q = q.next) s += q.v;
  holder = null;
  return s;
}
