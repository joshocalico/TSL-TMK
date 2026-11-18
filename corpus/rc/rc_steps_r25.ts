// R25: the freeing bound where a budget runs out between a one-slot object's two steps (SPEC 3.5, D39). With no collector
// linked an allocation's freeing is @tsl/gc's freeAlloc, which now takes the block's step of an object at the cursor with
// every slot visited itself, then frees on, and takes its last step in place too (slot 0's visit, the cursor left at slot
// 1). Each case queues objects with nothing made between, sets a budget, and counts the steps each `new` takes, what the
// three gave back, and what's live after, so a step taken twice, skipped, or taken out of order changes a number. A box's
// leaf is kept by the bag too, so a box is two steps (slot 0's visit, its block), and an odd budget leaves the cursor at a
// block every other allocation; a lone leaf is given back at once where there's a step to spare (visitLeaf). No class here
// is in a cycle. Every case reads @tsl/gc's counters, which plain JS doesn't have: they're `rcOnly`, pinned (the pins were
// worked out with @tsl/gc as it was before R25, so they say R25 takes the same steps), and the host's simulation agrees.
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
  made = new Vec(ref<Leaf>());
}

let _spare: Leaf | null = null;

function settle(): void {
  rcCollect();
  rcSetBudget(RC_BUDGET);
}

/** What `gone` gives back: the objects freed net of those made, 50 and up where more were made. */
function net(before: u32, after: u32): u32 {
  return after <= before ? before - after : 50 + (after - before);
}

/**
 * n boxes queued, each holding a leaf the bag keeps too (`shared`) or one of its own; then at budget `bud`, three `new`s.
 * Gives each `new`'s steps, two digits each, the objects the three gave back net of the three they made (two digits), and
 * whether collecting brings the live count back, 7 more if a kept leaf was freed under its box.
 */
export function boxesAt(n: u32, bud: u32, shared: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < n; i++) {
    const o = new Box(i);
    const l = new Leaf(i + 1);
    o.a = l;
    if (shared !== 0) b.kept.push(l);
    b.boxes.push(o);
  }
  let t: u32 = 0;
  for (let i: u32 = 0; i < n; i++) t += b.boxes.pop().w;
  const queued = toU32(rcLive());
  rcSetBudget(toUsize(bud));
  let out: u32 = 0;
  for (let i: u32 = 0; i < 3; i++) {
    const s0 = rcSteps();
    _spare = new Leaf(i + t);
    out = out * 100 + toU32(rcSteps() - s0);
  }
  const gone = net(queued + 1, toU32(rcLive()));
  let k: u32 = 0;
  let want: u32 = 0;
  for (let i: usize = 0; i < b.kept.length; i++) k += b.kept.get(i).w;
  if (shared !== 0) for (let i: u32 = 1; i <= n; i++) want += i;
  settle();
  _spare = null;
  b.kept.clear();
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0;
  return ((out * 100 + gone) * 10 + back) * 10 + (k === want ? 0 : 7);
}

/**
 * Boxes (their leaves kept) and pairs (their leaves their own) queued in turn, k of each, then `new`s at budget `bud`
 * until nothing waits: the cursor stops at blocks and at slots in turn. Gives how many `new`s that took * 100,000 + the
 * steps they took * 10 + whether the live count came back, 5 more if a kept leaf was freed.
 */
export function runOut(k: u32, bud: u32): u32 {
  settle();
  const live0 = rcLive();
  const b = new Bag();
  for (let i: u32 = 0; i < k; i++) {
    const x = new Box(i);
    const l = new Leaf(i + 3);
    x.a = l;
    b.kept.push(l);
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
  // what's live once everything queued is freed, and each `new` kept, so it makes nothing more to free
  const floor = toU32(rcLive()) - 4 * k;
  rcSetBudget(toUsize(bud));
  const s0 = rcSteps();
  let news: u32 = 0;
  while (toU32(rcLive()) > floor + news && news < 2000) {
    b.made.push(new Leaf(t + news));
    news++;
  }
  const all = rcSteps() - s0;
  let sum: u32 = 0;
  let want: u32 = 0;
  for (let i: usize = 0; i < b.kept.length; i++) sum += b.kept.get(i).w;
  for (let i: u32 = 0; i < k; i++) want += i + 3;
  settle();
  b.kept.clear();
  b.made.clear();
  rcCollect();
  const back: u32 = rcLive() === live0 + 1 ? 1 : 0;
  return news * 100_000 + toU32(all) * 10 + back + (sum === want ? 0 : 5);
}
