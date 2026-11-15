// A count reaching zero during a scan (SPEC 3.5, D41, R1e): the scan gives the object up, out of the scan and onto the
// freeing queue, and decides nothing until freeing has dropped every reference it held. Each function drops the last
// count on an object a scan has (a root, a member reached through another, a node of a list being freed, an object
// with many slots part way through being visited) after k allocations, at a budget of b with no pacing, going through
// every k in a range long enough to put the drop at every phase of the scan: taking roots, finding edges, marking,
// waiting for what it gave up, deciding and giving back, and between scans. What the given-up object held was counted
// as edges, so a scan that decided before it was dropped would free it, and the drop would then free it again. Each
// returns a digest V8 as written has to agree with, read from objects made after the drop, which two objects sharing a
// slot would change; the host's poisoned objects trap 5 on anything freed while reachable.
import { idiv, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCcGaveUp, rcCollect, rcLive, rcSetBudget, rcSetPacing } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class N {
  next: N | null = null;
  other: N | null = null;
  up: Many | null = null;
  constructor(public v: u32) {}
}

class Many {
  items = new Vec(ref<N>());
  constructor(public v: u32) {}
}

class Tick {
  constructor(public t: u32) {}
}

const M: u32 = 1_000_003;
const SETTLE: u32 = 200;

let _sink: Tick | null = null;
let g0: N | null = null;
let g1: N | null = null;
let gm: Many | null = null;

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

function ring(len: u32, seed: u32): N {
  const first = new N(seed);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const r = new N(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}

/** Made after the drop: 12 objects in a list, summed. Two of them in one slot would change the sum. */
function after(seed: u32): u32 {
  let head: N | null = null;
  for (let i: u32 = 0; i < 12; i++) {
    const n = new N(seed * 13 + i);
    n.next = head;
    head = n;
  }
  let t: u32 = 0;
  for (let p = head; p !== null; p = p.next) t = (t * 7 + p.v) % M;
  return t;
}

/** How many allocations a sweep needs at budget b to reach past the end of a scan of about `steps` steps. */
function reach(budget: u32, steps: u32): u32 {
  return idiv(steps, budget) + 6;
}

function sum(c: N | null, steps: u32): u32 {
  let t: u32 = 0;
  let p = c;
  for (let i: u32 = 0; i < steps && p !== null; i++) {
    t = (t * 3 + p.v) % M;
    p = p.next;
  }
  return t;
}

// The builders keep their locals' counts to themselves: when one returns, what it made is held only from the globals,
// and each object a local held is a candidate, its count having gone down to one.

function buildRoot(k: u32): void {
  const x = new N(k);
  x.other = ring(4, k);
  g0 = x;
}

/** x, held only by g0, a candidate, refers to a garbage ring: a scan takes x as a root, and its last count goes at k. */
export function rootGivenUp(budget: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 160);
  for (let k: u32 = 0; k < to; k++) {
    buildRoot(k);
    tick(k);
    g0 = null; // x's count reaches zero, k allocations after the scan could start
    tick(k & 3);
    t = mix(t, after(k));
    tick(SETTLE);
  }
  return end(t);
}

function buildMember(k: u32): void {
  const r = new N(k);
  r.other = new N(k + 1); // x: its count is the field's, and it was never a candidate
  r.other.other = ring(3, k);
  r.other.next = ring(2, k + 7);
  g0 = r;
}

/** r, a candidate, holds x, which holds two garbage rings: x joins a scan only through r, and r lets it go at k. */
export function memberGivenUp(budget: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 200);
  for (let k: u32 = 0; k < to; k++) {
    buildMember(k);
    tick(k);
    g0!.other = null; // x's last count, k allocations in
    tick(k & 3);
    t = mix(t, after(k) + g0!.v);
    g0 = null;
    tick(SETTLE);
  }
  return end(t);
}

function buildList(n: u32, k: u32): void {
  for (let i: u32 = 0; i < n; i++) {
    const a = new N(i + k);
    a.next = g0;
    g0 = a;
  }
}

/** A list of n whose every node is a candidate, as building it leaves them, dropped at k: freed while scans hold it. */
export function listGivenUp(budget: u32, n: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 6 * n);
  for (let k: u32 = 0; k < to; k++) {
    buildList(n, k);
    tick(k);
    g0 = null; // the head goes; each node's count reaches zero as freeing reaches it, with scans going on
    tick(k & 3);
    t = mix(t, after(k));
    tick(SETTLE);
  }
  return end(t);
}

function buildMany(k: u32): void {
  const m = new Many(k);
  const shared = ring(3, k);
  shared.up = m;
  for (let i: u32 = 0; i < 10; i++) m.items.push(i % 2 === 0 ? shared : ring(2, i));
  gm = m;
}

/** An object with 10 reference slots into garbage rings, let go at k: at some k, part way through being visited. */
export function manyGivenUp(budget: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 240);
  for (let k: u32 = 0; k < to; k++) {
    buildMany(k);
    const v = gm!.v;
    tick(k);
    gm = null; // its last count but the shared ring's back reference: the ring still holds it, so it's garbage, not given up
    tick(k & 3);
    t = mix(t, after(k) + v);
    tick(SETTLE);
  }
  return end(t);
}

function buildManyAlone(k: u32): void {
  const m = new Many(k);
  for (let i: u32 = 0; i < 10; i++) m.items.push(ring(2, i + k));
  gm = m;
}

/** The same with nothing referring back: its count reaches zero at k, part way through being visited at some k. */
export function manyAloneGivenUp(budget: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 240);
  for (let k: u32 = 0; k < to; k++) {
    buildManyAlone(k);
    const v = gm!.v;
    tick(k);
    gm = null;
    tick(k & 3);
    t = mix(t, after(k) + v);
    tick(SETTLE);
  }
  return end(t);
}

function buildHolder(k: u32): void {
  const r = ring(5, k);
  g1 = r.next!.next;
  const h = new N(k + 100);
  h.other = r.next;
  g0 = h;
}

/** A ring kept by g1, and a candidate h holding one of its members, let go at k: the ring stays, whole. */
export function holderGivenUp(budget: u32): u32 {
  begin(budget);
  let t: u32 = 0;
  const to = reach(budget, 160);
  for (let k: u32 = 0; k < to; k++) {
    buildHolder(k);
    tick(k);
    g0 = null;
    tick(k & 3);
    t = mix(t, sum(g1, 6));
    t = mix(t, after(k));
    g1 = null;
    tick(SETTLE);
  }
  return end(t);
}

/** listGivenUp's run, as rcOnly: 1 if some scan gave up an object, and the live count back where it was after. */
export function gaveUp(budget: u32, n: u32): u32 {
  _sink = null;
  rcCollect();
  const g: usize = rcCcGaveUp();
  const live: usize = rcLive();
  listGivenUp(budget, n);
  _sink = null;
  rcCollect();
  return (rcCcGaveUp() > g ? 1 : 0) * 10 + (rcLive() === live ? 0 : 1);
}

export function last(): u32 {
  g0 = null;
  g1 = null;
  gm = null;
  _sink = null;
  return 0;
}
