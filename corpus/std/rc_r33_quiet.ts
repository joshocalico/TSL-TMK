// R33 (SPEC 3.5, D39): hand-written stores whose release functions only visit their slots (no make, no leaf, no room), and
// no class in a cycle, so no release function can read or write `stepping` or `spare` (`releasesTouch` says so) and @tsl/gc
// sets neither around a release call: each visit's step is the budget's one less, as `spare` would come back. With small
// budgets, how many objects are live after each allocation, and the steps taken in all, show any step miscounted. The same
// on V8, where both are always set, and natively.
import { RC_BUDGET, Rc, rcLive, rcSetBudget, rcSteps, Visit, type Counted } from "@tsl/gc";
import { toU32, type u32, type usize } from "@tsl/core";

class Note {
  constructor(public v: u32) {}
}

class Item {
  note: Counted<Note> | null = null;
  constructor(public v: u32) {}
}

class Pair {
  a: Counted<Item> | null = null;
  b: Counted<Item> | null = null;
  constructor(public v: u32) {}
}

function releaseNote(_n: Note, _at: usize, _op: Visit): usize {
  return 0;
}

/** An item's one slot, its note. */
function releaseItem(it: Item, at: usize, op: Visit): usize {
  const n = it.note;
  if (at === 0 && n !== null) notes.visit(n, op);
  return 1;
}

/** A pair's two slots, its items. */
function releasePair(p: Pair, at: usize, op: Visit): usize {
  const a = p.a;
  const b = p.b;
  if (at === 0 && a !== null) items.visit(a, op);
  if (at === 1 && b !== null) items.visit(b, op);
  return 2;
}

const notes = new Rc<Note>(releaseNote);
const items = new Rc<Item>(releaseItem);
const pairs = new Rc<Pair>(releasePair);

function mix(h: u32, x: u32): u32 {
  return Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
}

/** An item with a note. */
function item(v: u32): Counted<Item> {
  const it = items.make(new Item(v));
  it.note = notes.make(new Note(v * 3));
  return it;
}

/** n items made and dropped one after another at a budget of b: each allocation's live count mixed in. */
export function chain(n: u32, b: u32): u32 {
  rcSetBudget(b);
  const s0 = rcSteps();
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const it = item(i);
    h = mix(h, toU32(rcLive()));
    items.drop(it);
  }
  rcSetBudget(RC_BUDGET);
  items.collect();
  return mix(h, toU32(rcSteps() - s0));
}

/** n pairs of items made and dropped one after another at a budget of b, then notes alone: each live count mixed in. */
export function pairsOf(n: u32, b: u32): u32 {
  rcSetBudget(b);
  const s0 = rcSteps();
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const p = pairs.make(new Pair(i));
    p.a = item(i);
    p.b = item(i + 100);
    h = mix(h, toU32(rcLive()));
    pairs.drop(p);
  }
  for (let i: u32 = 0; i < n; i++) {
    const t = notes.make(new Note(i));
    h = mix(h, toU32(rcLive()));
    notes.drop(t);
  }
  rcSetBudget(RC_BUDGET);
  pairs.collect();
  return mix(h, toU32(rcSteps() - s0));
}
