// The cycle collector's latency (SPEC 3.5, D41, R1c), ported from M5 Phase E's: tools/rc-tests.ts's driver times each
// `step`, one allocation with its freeing and collecting work, by the virtual counter, with no pacing so that every
// allocation does its share. Four phases, set up by `setup`: nothing pending; a dropped ring being collected; a dropped
// doubly linked list being collected; and a live ring scanned over and over, as each step makes a member a candidate
// again. `maxSteps` is the most steps any one step's allocation took, which is deterministic and at most the budget.
// Timing under QEMU isn't a gate: a host can preempt a guest. Not a corpus program: what it's for is the driver's timing.
import { type u32, type usize, toU32 } from "@tsl/core";
import { rcCcFreed, rcCollect, rcSetPacing, rcSteps } from "@tsl/gc";

class Tick {
  constructor(public t: u32) {}
}
class R {
  next: R | null = null;
  constructor(public v: u32) {}
}
class L {
  prev: L | null = null;
  next: L | null = null;
  constructor(public v: u32) {}
}

let _sink: Tick | null = null;
let live: R | null = null;
let most: usize = 0;
let freedBefore: usize = 0;

function ring(len: u32): R {
  const first = new R(0);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const r = new R(i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}

function chain(len: u32): u32 {
  const first = new L(0);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const l = new L(i);
    l.prev = last;
    last.next = l;
    last = l;
  }
  first.prev = last;
  last.next = first;
  return last.v;
}

/** 0 idle, 1 a ring of `size` dropped, 2 a doubly linked list of `size` dropped, 3 a live ring of `size` kept. */
export function setup(phase: u32, size: u32): u32 {
  live = null;
  rcCollect();
  rcSetPacing(false);
  most = 0;
  freedBefore = rcCcFreed();
  let v: u32 = 0;
  if (phase === 1) {
    const r = ring(size);
    v = r.v;
  } else if (phase === 2) v = chain(size);
  else if (phase === 3) live = ring(size);
  return v;
}

/** One allocation, timed by the driver; in phase 3, first a share and a drop of a live member, a candidate again. */
export function step(phase: u32, i: u32): u32 {
  if (phase === 3) {
    const l = live;
    if (l !== null) {
      const n = l.next;
      l.next = n;
    }
  }
  const s0 = rcSteps();
  _sink = new Tick(i);
  const d = rcSteps() - s0;
  if (d > most) most = d;
  return i;
}

export function maxSteps(): u32 {
  rcSetPacing(true);
  return toU32(most);
}

/** Objects the collector freed since setup: a dropped ring or list of `size` is all of it, once collected. */
export function freed(): u32 {
  return toU32(rcCcFreed() - freedBefore);
}
