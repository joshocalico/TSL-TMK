// R17: the freeing bound where objects with no slots of their own wait (SPEC 3.5, D39): @tsl/gc gives such an object's
// block back without calling its release function, which does nothing (`releaseIsEmpty`), so it has to stay exactly one
// step, and an allocation exactly its budget. Leaves are put on the queue with nothing made between (popped from a vector,
// each dropped as it's popped), alone and between objects with three references each, and then counted: the steps one
// `new` takes, the objects it gave back, and the steps freeing all of it takes. No class here is in a cycle, so the
// collector isn't linked and an allocation spends its whole budget. Every case reads @tsl/gc's counters, which plain JS
// doesn't have: they're `rcOnly`, pinned, and the host's simulation, which calls every release function, has to agree.
import { toU32, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCollect, rcLive, rcSetBudget, rcSteps } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class Leaf {
  constructor(public w: u32) {}
}

class Trio {
  a: Leaf | null = null;
  b: Leaf | null = null;
  c: Leaf | null = null;
  constructor(public w: u32) {}
}

class Bag {
  leaves = new Vec(ref<Leaf>());
  trios = new Vec(ref<Trio>());
}

let _spare: Leaf | null = null;

function settle(): void {
  rcCollect();
  rcSetBudget(RC_BUDGET);
}

/**
 * n leaves put on the queue, then one `new`: it gives back min(n, RC_BUDGET) of them, a step each, and freeing the rest
 * takes one step a leaf. Gives the first `new`'s steps * 1,000,000 + the objects it gave back * 1,000 + all the steps.
 */
export function leavesQueued(n: u32): u32 {
  settle();
  const b = new Bag();
  for (let i: u32 = 0; i < n; i++) b.leaves.push(new Leaf(i));
  let t: u32 = 0;
  const live0 = rcLive();
  for (let i: u32 = 0; i < n; i++) t += b.leaves.pop().w;
  const s0 = rcSteps();
  _spare = new Leaf(t);
  const one = rcSteps() - s0;
  const freed = live0 + 1 - rcLive();
  rcCollect();
  const all = rcSteps() - s0;
  _spare = null;
  rcCollect();
  return toU32(one) * 1_000_000 + toU32(freed) * 1_000 + toU32(all);
}

/**
 * k leaves and k objects of three leaves each, put on the queue in turn (a leaf, then an object), then one `new`. Freeing
 * an object is its three slots, its three leaves (given back at once while the budget has a step to spare, R4, or later,
 * a step each) and its block: 7 steps; a leaf is one. So the first `new` takes min(8k, RC_BUDGET) steps, crossing from
 * leaves to objects and back, and all of it 8k. Gives the first `new`'s steps * 1,000,000 + all the steps * 10 + 1 if the
 * live count came back to where it was.
 */
export function mixedQueued(k: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < k; i++) {
    b.leaves.push(new Leaf(i));
    const o = new Trio(i);
    o.a = new Leaf(i + 1);
    o.b = new Leaf(i + 2);
    o.c = new Leaf(i + 3);
    b.trios.push(o);
  }
  let t: u32 = 0;
  for (let i: u32 = 0; i < k; i++) {
    t += b.leaves.pop().w;
    t += b.trios.pop().w;
  }
  const s0 = rcSteps();
  _spare = new Leaf(t);
  const one = rcSteps() - s0;
  rcCollect();
  const all = rcSteps() - s0;
  _spare = null;
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0; // the bag is still held here
  return toU32(one) * 1_000_000 + toU32(all) * 10 + back;
}

/** At budgets 1, 2 and 3, with n leaves waiting, each of five `new`s takes exactly that many steps. */
export function budgetsLeaves(n: u32): u32 {
  let out: u32 = 0;
  for (let bud: usize = 1; bud <= 3; bud++) {
    settle();
    const b = new Bag();
    for (let i: u32 = 0; i < n; i++) b.leaves.push(new Leaf(i));
    let t: u32 = 0;
    for (let i: u32 = 0; i < n; i++) t += b.leaves.pop().w;
    rcSetBudget(bud);
    const s0 = rcSteps();
    for (let i: u32 = 0; i < 5; i++) _spare = new Leaf(i + t);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  settle();
  _spare = null;
  return out;
}
