// R33 (SPEC 3.5, D39): a release function that makes a counted object only through a function value, an indirect call the
// call graph can't follow, so @tsl/gc must set `stepping` around its release calls (`releasesTouch` says a release function
// may read it): a `make` inside a release function takes no freeing steps of its own. With a small budget, how many objects
// are live after each allocation shows whether the make inside took steps the budget didn't count. The same on V8, where
// `stepping` is always set, and natively.
import { RC_BUDGET, Rc, rcLive, rcSetBudget, rcSteps, Visit, type Counted } from "@tsl/gc";
import { toU32, type u32, type usize } from "@tsl/core";

class Note {
  constructor(public v: u32) {}
}

class Item {
  note: Counted<Note> | null = null;
  constructor(public v: u32) {}
}

let made: u32 = 0;

function releaseNote(_n: Note, _at: usize, _op: Visit): usize {
  return 0;
}

/** A note made and let go of at once: inside a release function, its make takes no steps. */
function noteFor(v: u32): void {
  const n = notes.make(new Note(v));
  made = (made + n.v) % 100000;
  notes.drop(n);
}

/** Calls what it's given: from the release function below, a function value, so an indirect call. */
/** @tsl.noinline */
function hook(f: (v: u32) => void, v: u32): void {
  f(v);
}

/** An item's one slot, its note, released; freeing it makes a note, by way of the hook. */
function releaseItem(it: Item, at: usize, op: Visit): usize {
  const n = it.note;
  if (at === 0) {
    if (n !== null) notes.visit(n, op);
    if (op === Visit.Drop) hook(noteFor, it.v);
  }
  return 1;
}

const notes = new Rc<Note>(releaseNote);
const items = new Rc<Item>(releaseItem);

function mix(h: u32, x: u32): u32 {
  return Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
}

/** n items, each with a note, made and dropped one after another at a budget of b: each allocation's live count mixed in. */
export function chain(n: u32, b: u32): u32 {
  rcSetBudget(b);
  made = 0;
  const s0 = rcSteps();
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const it = items.make(new Item(i));
    it.note = notes.make(new Note(i * 3));
    h = mix(h, toU32(rcLive()));
    items.drop(it);
  }
  rcSetBudget(RC_BUDGET);
  items.collect();
  return mix(mix(h, made), toU32(rcSteps() - s0));
}

/** Items held in a batch, then all dropped, then plain notes made one at a time at a budget of b. */
export function batch(n: u32, b: u32): u32 {
  rcSetBudget(b);
  made = 0;
  const s0 = rcSteps();
  let h: u32 = 0;
  let a: Counted<Item> | null = null;
  let c: Counted<Item> | null = null;
  for (let i: u32 = 0; i < n; i++) {
    const it = items.make(new Item(i + 1));
    it.note = notes.make(new Note(i));
    if (a !== null) items.drop(a);
    a = c;
    c = it;
  }
  if (a !== null) items.drop(a);
  if (c !== null) items.drop(c);
  for (let i: u32 = 0; i < n; i++) {
    const t = notes.make(new Note(i));
    h = mix(h, toU32(rcLive()));
    notes.drop(t);
  }
  rcSetBudget(RC_BUDGET);
  items.collect();
  return mix(mix(h, made), toU32(rcSteps() - s0));
}
