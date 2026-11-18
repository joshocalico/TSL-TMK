// R24: the freeing bound where what waits has one slot or two (SPEC 3.5, D39): with no collector linked an allocation's
// freeing is @tsl/gc's freeAlloc, which frees an object of one slot in place (slot 0's visit, then its block, a step each),
// leaves the cursor at slot 1 where the budget runs out after slot 0, and hands an object of more slots to freeRest. Each
// case queues objects with nothing made between, sets a budget, and counts the steps each of five `new`s takes and what's
// live after, so a step taken twice, skipped, or taken out of order changes a number. A leaf a slot holds alone is given
// back at once while the budget has a step to spare (visitLeaf); one that's shared keeps its other count. No class here is
// in a cycle. Every case reads @tsl/gc's counters, which plain JS doesn't have: they're `rcOnly`, pinned (the pins were
// worked out with @tsl/gc as it was before R24, so they say R24 takes the same steps), and the host's simulation agrees.
import { toU32, toUsize, type u32, type usize } from "@tsl/core";
import { RC_BUDGET, rcCollect, rcLive, rcSetBudget, rcSteps } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class Leaf {
  constructor(public w: u32) {}
}

class Box {
  a: Leaf | null = null;
  constructor(public w: u32) {}
}

class Pair {
  a: Leaf | null = null;
  b: Leaf | null = null;
  constructor(public w: u32) {}
}

class Bag {
  boxes = new Vec(ref<Box>());
  pairs = new Vec(ref<Pair>());
  kept = new Vec(ref<Leaf>());
}

let _spare: Leaf | null = null;

function settle(): void {
  rcCollect();
  rcSetBudget(RC_BUDGET);
}

/**
 * n boxes, each holding a leaf of its own (or, with `shared`, a leaf the bag keeps too), queued; then at budget `bud`, four
 * `new`s. Gives each `new`'s steps, two digits each, then whether the live count after collecting is where it started, and
 * 7 more if a kept leaf was freed under it.
 */
export function boxesQueued(n: u32, bud: u32, shared: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < n; i++) {
    const o = new Box(i);
    if (shared !== 0) {
      const l = new Leaf(i + 1);
      o.a = l;
      b.kept.push(l);
    } else o.a = new Leaf(i + 1);
    b.boxes.push(o);
  }
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) t += b.boxes.pop().w;
  rcSetBudget(toUsize(bud));
  let out: u32 = 0;
  for (let i: u32 = 0; i < 4; i++) {
    const s0 = rcSteps();
    _spare = new Leaf(i + t);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  let k: u32 = 0;
  let want: u32 = 0;
  for (let i: usize = 0; i < b.kept.length; i++) k += b.kept.get(i).w;
  if (shared !== 0) for (let i: u32 = 1; i <= n; i++) want += i;
  settle();
  _spare = null;
  b.kept.clear();
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0; // the bag is still held here
  return out * 10 + back + (k === want ? 0 : 7);
}

/**
 * n pairs, each holding two leaves of its own, queued; then at budget `bud`, three `new`s: each pair is slot 0, slot 1 (its
 * leaves given back at once while there's a step to spare) and its block. Gives each `new`'s steps, two digits each, then
 * the objects the three gave back, net of the three they made (two digits, 50 and up for more made than given back), and
 * whether collecting brings it back.
 */
export function pairsQueued(n: u32, bud: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < n; i++) {
    const o = new Pair(i);
    o.a = new Leaf(i);
    o.b = new Leaf(i + 1);
    b.pairs.push(o);
  }
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) t += b.pairs.pop().w;
  const liveQueued = rcLive();
  rcSetBudget(toUsize(bud));
  let out: u32 = 0;
  for (let i: u32 = 0; i < 3; i++) {
    const s0 = rcSteps();
    _spare = new Leaf(i + t);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  // what the three gave back, net of what they made: 50 and up where they made more than they gave back
  const after = rcLive();
  const gone: u32 =
    after <= liveQueued + 1 ? toU32(liveQueued + 1 - after) : 50 + toU32(after - liveQueued - 1);
  settle();
  _spare = null;
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0;
  return (out * 100 + gone) * 10 + back;
}

/**
 * Boxes and pairs queued in turn, k of each, then one `new` at RC_BUDGET and the steps freeing all of it takes: the budget
 * crosses from one shape to the other, and the cursor stops part way through one. Gives the first `new`'s steps * 100,000 +
 * all the steps * 10 + whether the live count came back.
 */
export function mixedShapes(k: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < k; i++) {
    const x = new Box(i);
    x.a = new Leaf(i);
    b.boxes.push(x);
    const y = new Pair(i);
    y.a = new Leaf(i);
    y.b = new Leaf(i + 2);
    b.pairs.push(y);
  }
  let t: u32 = 0;
  for (let i: u32 = 0; i < k; i++) {
    t += b.boxes.pop().w;
    t += b.pairs.pop().w;
  }
  const s0 = rcSteps();
  _spare = new Leaf(t);
  const one = rcSteps() - s0;
  rcCollect();
  const all = rcSteps() - s0;
  _spare = null;
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0;
  return toU32(one) * 100_000 + toU32(all) * 10 + back;
}
