// The freeing bound as a count (SPEC 3.5, D39, D74): every allocation does at most RC_BUDGET steps of freeing, one
// reference slot visited or one block given back a step, with a cursor through the object being freed. `Node` can be in a
// cycle, so the collector is linked, and then an allocation frees one object, two steps, unless its size's list is
// empty (D41's phase-E rule, as the direct route's, R1e). So a dropped list goes a node a `new` (a slot and a block),
// and a dropped vector of a million references goes 2 references a `new`, never at once. Every case reads @tsl/gc's step counter, which plain JS doesn't have: they're `rcOnly`, pinned,
// and the host's simulation of Rc has to give what native code gives.
import { toU32, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCollect, rcLive, rcSetBudget, rcSteps } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}
}

class Leaf {
  constructor(public w: u32) {}
}

class Holder {
  all = new Vec(ref<Leaf>());
}

let list: Node | null = null;
let _holder: Holder | null = null;
let _spare: Leaf | null = null;

function settle(): void {
  rcCollect();
  rcSetBudget(RC_BUDGET);
}

/** Steps and objects freed by one `new` after dropping a list of n: one object's two steps, and one node. */
export function listDrop(n: u32): u32 {
  settle();
  for (let i: u32 = 0; i < n; i++) {
    const node = new Node(i);
    node.next = list;
    list = node;
  }
  list = null;
  const live0 = rcLive();
  const s0 = rcSteps();
  _spare = new Leaf(1);
  const steps = rcSteps() - s0;
  const freed = live0 + 1 - rcLive();
  _spare = null;
  return toU32(steps) * 1000 + toU32(freed);
}

/** At budgets 1, 2 and 3, each `new` does exactly that many steps, at most two, while anything is waiting. */
export function budgets(n: u32): u32 {
  let out: u32 = 0;
  for (let b: usize = 1; b <= 3; b++) {
    settle();
    for (let i: u32 = 0; i < n; i++) {
      const node = new Node(i);
      node.next = list;
      list = node;
    }
    list = null;
    rcSetBudget(b);
    const s0 = rcSteps();
    for (let i: u32 = 0; i < 5; i++) _spare = new Leaf(i);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  settle();
  _spare = null;
  return out;
}

/**
 * A holder of n references, all to one leaf, dropped: one `new` visits 2 of them, and collecting the rest takes exactly
 * n + 2 steps in all: each reference, the vector's buffer and the holder's block (the leaf is still held by a local).
 */
export function bigVector(n: u32): u32 {
  settle();
  const h = new Holder();
  const leaf = new Leaf(7);
  for (let i: u32 = 0; i < n; i++) h.all.push(leaf);
  _holder = h;
  return dropBig();
}

function dropBig(): u32 {
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
  return (
    toU32(one) * 100_000_000 + toU32(all - one) + (liveAfterOne === live0 + 1 ? 0 : 50_000_000)
  );
}

/**
 * Replacing a global: each `new` frees the leaf the one before last replaced, as a store counts the new value before it
 * drops the old (D39's order), so 100 replacements free 98 leaves, one step each, and nothing else is ever waiting.
 */
export function replacing(): u32 {
  settle();
  const s0 = rcSteps();
  for (let i: u32 = 0; i < 100; i++) _spare = new Leaf(i);
  const s1 = rcSteps() - s0;
  _spare = null;
  return toU32(s1);
}
