// R34 (SPEC 3.5, D39's R34): @tsl/gc's leaves, by hand. Strings in the shape of the lowered runtime's: flat ones, whose one
// reference is null and stays so, made by `makeTailLeaf` into their store's leaf entry, so freeing gives each back as one
// step with no call, a run of them in one pass with the budget brought down once; and views, made by `makeTail`, whose
// buffer, a leaf, their release function hands back to freeing through what it returns (`handLeaf`, `RC_HANDED`), where
// R4's `visitLeaf` gave it back through `spare`. Runs of each kind waiting are broken by the other kinds and by other
// stores, and every allocation's live count and steps, at budgets from 1 up, are mixed into the answer, so a step too many
// or too few, a leaf freed twice or never, or a view freed without its buffer shows. `sameAsVisitLeaf` runs one shape twice,
// once handing leaves back and once through `visitLeaf`, and says whether every allocation took the same steps and left the
// same live count. The same on V8, JSC and natively.
import { tail, toU32, toUsize, u16, wrapU16, type bool, type u32, type usize } from "@tsl/core";
import {
  RC_BUDGET,
  RC_HANDED,
  Rc,
  rcLive,
  rcSetBudget,
  rcSteps,
  Visit,
  type Counted,
} from "@tsl/gc";
import { ref, Vec } from "@tsl/std";

class Buf {
  units = tail(u16);
}

class Str {
  buf: Counted<Buf> | null = null;
  constructor(
    public n: u32,
    buf: Counted<Buf> | null,
  ) {
    this.buf = buf;
  }
  units = tail(u16);
}

class Note {
  constructor(public v: u32) {}
}

/** The same shape as Str, its buffer given back through `visitLeaf` (R4's way). */
class OldStr {
  buf: Counted<Buf> | null = null;
  constructor(
    public n: u32,
    buf: Counted<Buf> | null,
  ) {
    this.buf = buf;
  }
  units = tail(u16);
}

function releaseBuf(_b: Buf, _at: usize, _op: Visit): usize {
  return 0;
}

function releaseNote(_n: Note, _at: usize, _op: Visit): usize {
  return 0;
}

/** A string's one slot, its buffer, handed back to freeing at its last count. */
function releaseStr(s: Str, at: usize, op: Visit): usize {
  const b = s.buf;
  if (at === 0 && b !== null && bufs.handLeaf(b, op)) return 1 + RC_HANDED;
  return 1;
}

function releaseOldStr(s: OldStr, at: usize, op: Visit): usize {
  const b = s.buf;
  if (at === 0 && b !== null) bufs.visitLeaf(b, op);
  return 1;
}

const bufs = new Rc<Buf>(releaseBuf);
const notes = new Rc<Note>(releaseNote);
const strs = new Rc<Str>(releaseStr);
const olds = new Rc<OldStr>(releaseOldStr);

class Held {
  s = new Vec(ref<Str>());
  o = new Vec(ref<OldStr>());
  n = new Vec(ref<Note>());
}

function mix(h: u32, x: u32): u32 {
  return Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
}

function flat(n: u32): Counted<Str> {
  const s = strs.makeTailLeaf(toUsize(n), new Str(n, null));
  for (let i: usize = 0; i < s.units.length; i++) s.units[i] = wrapU16(toU32(i) + n);
  return s;
}

function view(n: u32): Counted<Str> {
  const b = bufs.makeTail(toUsize(n) * 2, new Buf());
  return strs.makeTail(0, new Str(n, b));
}

function oldView(n: u32): Counted<OldStr> {
  const b = bufs.makeTail(toUsize(n) * 2, new Buf());
  return olds.makeTail(0, new OldStr(n, b));
}

/** What each allocation took and left: steps and live count, mixed. */
function step(h: u32, s0: usize): u32 {
  return mix(mix(h, toU32(rcSteps() - s0)), toU32(rcLive()));
}

/**
 * n strings made in turn (flat, flat, view, a note, flat, …: `kinds` says which, three bits each), all dropped, then
 * allocations at a budget of b until nothing's left: each one's steps and live count mixed in, and the last live count.
 */
export function runs(n: u32, kinds: u32, b: u32): u32 {
  strs.collect();
  const live0 = rcLive();
  const held = new Held();
  for (let i: u32 = 0; i < n; i++) {
    const k = (kinds >>> ((i % 10) * 3)) & 7;
    if (k === 1) held.s.push(view(i % 9));
    else if (k === 2) held.n.push(notes.make(new Note(i)));
    else held.s.push(flat(i % 13));
  }
  rcSetBudget(toUsize(b));
  const s0 = rcSteps();
  let h: u32 = 0;
  while (held.s.length > 0) strs.drop(held.s.pop());
  while (held.n.length > 0) notes.drop(held.n.pop());
  for (let i: u32 = 0; i < 4 * n + 4; i++) {
    const t = flat(i % 5);
    h = step(h, s0);
    strs.drop(t);
  }
  rcSetBudget(RC_BUDGET);
  strs.collect();
  return mix(mix(h, toU32(rcLive() - live0)), toU32(rcSteps() - s0));
}

/** Views and flat strings dropped in turn, one each allocation, at a budget of b: each allocation's steps and live count. */
export function churn(n: u32, b: u32): u32 {
  strs.collect();
  const live0 = rcLive();
  rcSetBudget(toUsize(b));
  const s0 = rcSteps();
  let h: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const v = view((i % 7) + 1);
    h = step(h, s0);
    const f = flat(i % 3);
    h = step(h, s0);
    strs.drop(v);
    strs.drop(f);
  }
  rcSetBudget(RC_BUDGET);
  strs.collect();
  return mix(mix(h, toU32(rcLive() - live0)), toU32(rcSteps() - s0));
}

/** One shape's allocations, each one's steps and live count, through Str (handLeaf) or OldStr (visitLeaf). */
function shape(n: u32, b: u32, handing: bool): u32 {
  strs.collect();
  rcSetBudget(toUsize(b));
  const s0 = rcSteps();
  const live0 = rcLive();
  let h: u32 = 0;
  const held = new Held();
  for (let i: u32 = 0; i < n; i++) {
    if (handing) held.s.push(view((i % 5) + 1));
    else held.o.push(oldView((i % 5) + 1));
  }
  while (held.s.length > 0) strs.drop(held.s.pop());
  while (held.o.length > 0) olds.drop(held.o.pop());
  for (let i: u32 = 0; i < 2 * n + 2; i++) {
    const t = notes.make(new Note(i));
    h = mix(mix(h, toU32(rcSteps() - s0)), toU32(rcLive() - live0));
    notes.drop(t);
  }
  rcSetBudget(RC_BUDGET);
  strs.collect();
  return mix(h, toU32(rcSteps() - s0));
}

/** Whether handing a view's buffer back takes visitLeaf's steps exactly, allocation by allocation: 1 if so. */
export function sameAsVisitLeaf(n: u32, b: u32): u32 {
  const a = shape(n, b, true);
  const c = shape(n, b, false);
  return a === c ? 1 : (mix(a, c) | 2) >>> 0;
}
