// WeakRef and the cycle collector (SPEC 3.5, D41, R1c): a weak reference to a member of a garbage cycle can give its
// target until the collector decides, and `undefined` from the decision on, including while the cycle is partway through
// being released and given back. Each case drops a ring held only weakly, then derefs after every allocation with the
// collector at a small budget and no pacing, so some deref lands between the decision and the target's block going back.
// A deref there that gave the target would hand out an object about to be freed. V8 keeps targets as long as it likes
// (3.10, item 9), so those cases are `rcOnly`, and pinned.
import { RC_BUDGET, rcSetBudget, rcSetPacing } from "@tsl/gc";
import { type u32 } from "@tsl/core";

class R {
  next: R | null = null;
  constructor(public v: u32) {}
}

class Tick {
  constructor(public t: u32) {}
}

let _sink: Tick | null = null;
let keep: R | null = null;

function ring(len: u32, seed: u32): R {
  const first = new R(seed);
  let last = first;
  for (let i: u32 = 1; i < len; i++) {
    const r = new R(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}

function weakTo(len: u32, seed: u32): WeakRef<R> {
  const r = ring(len, seed);
  return new WeakRef(r);
}

/**
 * `quiet` allocations with no deref, then a deref after each of `ticks` more: how many gave the target, and what was read
 * through it, in a digest. A deref is a count operation, so one during a scan holds the target: the quiet stretch lets a
 * scan get as far as its decision, and some `quiet` puts the first deref after it.
 */
function watch(w: WeakRef<R>, quiet: u32, ticks: u32): u32 {
  let seen: u32 = 0;
  let sum: u32 = 0;
  for (let k: u32 = 0; k < quiet; k++) _sink = new Tick(k);
  for (let k: u32 = 0; k < ticks; k++) {
    _sink = new Tick(k);
    const x = w.deref();
    if (x !== undefined) {
      seen++;
      const n = x.next;
      sum = (sum + x.v + (n === null ? 0 : n.v)) % 1_000_003;
    }
  }
  return seen * 1000 + (sum % 1000);
}

/** A ring dropped, held only by a weak reference: derefs while the collector decides and frees it. */
export function partway(budget: u32, len: u32, quiet: u32): u32 {
  rcSetBudget(budget);
  rcSetPacing(false);
  const w = weakTo(len, 7);
  const r = watch(w, quiet, 40);
  rcSetBudget(RC_BUDGET);
  rcSetPacing(true);
  return r;
}

/** The same ring kept by a global: every deref gives it, whatever the collector does around it. */
export function keptRing(budget: u32, len: u32): u32 {
  rcSetBudget(budget);
  rcSetPacing(false);
  keep = ring(len, 3);
  const w = new WeakRef(keep);
  const r = watch(w, 0, 200);
  keep = null;
  rcSetBudget(RC_BUDGET);
  rcSetPacing(true);
  return r;
}
