// The freeing bound as a count with no collector linked (SPEC 3.5, D39, D74; B3): every class here is in no cycle, so
// @tsl/gc's cycle collector isn't linked, and an allocation spends its whole budget, RC_BUDGET steps, on freeing: one
// reference slot visited or one block given back a step, with a cursor through the object being freed. rc_steps.ts shows
// the bound with the collector linked (one object, two steps, an allocation); this is the path R1f found nothing tested:
// freeing that ran to the end at once here would give every result below a different number. Every case reads @tsl/gc's
// step counter, which plain JS doesn't have: they're `rcOnly`, pinned, and the host's simulation has to agree.
import { toU32, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCollect, rcLive, rcSetBudget, rcSteps } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class Leaf {
  constructor(public w: u32) {}
}

class Holder {
  all = new Vec(ref<Leaf>());
}

let _holder: Holder | null = null;
let _spare: Leaf | null = null;

function settle(): void {
  rcCollect();
  rcSetBudget(RC_BUDGET);
}

/**
 * A holder of n references to one leaf, dropped: one `new` visits RC_BUDGET of them, and collecting the rest takes the other
 * n + 2 - RC_BUDGET steps (each reference, the vector's buffer and the holder's block; the leaf is held by a local).
 */
export function bigVector(n: u32): u32 {
  settle();
  const h = new Holder();
  const leaf = new Leaf(7);
  for (let i: u32 = 0; i < n; i++) h.all.push(leaf);
  _holder = h;
  const live0 = rcLive();
  _holder = null;
  const s0 = rcSteps();
  _spare = new Leaf(2);
  const one = rcSteps() - s0;
  const liveAfterOne = rcLive();
  rcCollect();
  const all = rcSteps() - s0;
  _spare = null;
  rcCollect();
  return toU32(one) * 10_000_000 + toU32(all - one) + (liveAfterOne === live0 + 1 ? 0 : 5_000_000);
}

/**
 * A holder of n leaves of its own, dropped: one `new` takes RC_BUDGET steps, all on the holder's references (the cursor
 * finishes an object before the next). Since R4 each leaf whose last count a reference's visit drops is given back at once,
 * as a second step of that budget (`visitLeaf`), so the 32 steps visit 16 references and free their 16 leaves, where
 * before they visited 32 and the leaves waited; collecting all of it still takes 2n + 2 steps.
 */
export function leavesDrop(n: u32): u32 {
  settle();
  const h = new Holder();
  for (let i: u32 = 0; i < n; i++) h.all.push(new Leaf(i));
  _holder = h;
  const live0 = rcLive();
  _holder = null;
  const s0 = rcSteps();
  _spare = new Leaf(3);
  const one = rcSteps() - s0;
  const freed = live0 + 1 - rcLive();
  rcCollect();
  const all = rcSteps() - s0;
  _spare = null;
  rcCollect();
  return toU32(one) * 100_000 + toU32(freed) * 10_000_000 + toU32(all - one);
}

/** At budgets 1, 2 and 3, each `new` does exactly that many steps while anything is waiting: no cap of two here. */
export function budgets(n: u32): u32 {
  let out: u32 = 0;
  for (let b: usize = 1; b <= 3; b++) {
    settle();
    const h = new Holder();
    for (let i: u32 = 0; i < n; i++) h.all.push(new Leaf(i));
    _holder = h;
    _holder = null;
    rcSetBudget(b);
    const s0 = rcSteps();
    for (let i: u32 = 0; i < 5; i++) _spare = new Leaf(i);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  settle();
  _spare = null;
  return out;
}
