// memory-pages: 64
// R30 (SPEC 3.5, 4.3): `make` and `makeTail` place the object where it's made. @tsl/gc finds only the slot out of line
// (slotSlow, slotAfter, tailSlot, tailSlotAfter), so the moved object is never given to a call, and at -O2 scalar
// replacement writes its fields straight into the slot (a copy out of a frame slot becomes stores, sroa.ts). Objects of
// several fields, set by their constructors from arguments and after, made on every way a slot comes (a store's first, off
// a list, cut fresh, a fresh page), with tails of lengths that change, each read back. Every answer is V8's, at every level.
import {
  tail,
  toF64,
  toI32,
  toU32,
  toUsize,
  u16,
  wrapU16,
  wrapU32,
  type f64,
  type i32,
  type u32,
  type usize,
} from "@tsl/core";
import { Rc, Visit, type Counted } from "@tsl/gc";

class Point {
  next: Counted<Point> | null = null;
  w: f64 = 0;
  constructor(
    public x: i32,
    public y: i32,
    public tag: u32,
  ) {
    this.w = toF64(this.x) * 0.5 + toF64(this.y);
  }
}

function releasePoint(p: Point, at: usize, op: Visit): usize {
  const next = p.next;
  if (at === 0 && next !== null) points.visit(next, op);
  return 1;
}

const points = new Rc<Point>(releasePoint);

class Word {
  first: u32 = 7;
  constructor(public id: i32) {}
  units = tail(u16);
}

function releaseWord(_w: Word, _at: usize, _op: Visit): usize {
  return 0;
}

const words = new Rc<Word>(releaseWord);

/** k points chained, each read back from its fields: a sum of what each holds, and how many were wrong. */
export function chain(k: i32): i32 {
  let head: Counted<Point> | null = null;
  let bad: i32 = 0;
  for (let i: i32 = 0; i < k; i++) {
    const y = Math.imul(i, 3) - 7;
    const tag = wrapU32(Math.imul(i, -1640531535));
    const p = points.make(new Point(i, y, tag));
    if (p.x !== i || p.y !== y || p.tag !== tag || p.next !== null) bad++;
    if (p.w !== toF64(i) * 0.5 + toF64(y)) bad++;
    p.next = head;
    head = p;
  }
  let sum: i32 = 0;
  let at = head;
  while (at !== null) {
    sum = (sum + at.x + at.y + toI32(at.tag & 0xffff)) | 0;
    at = at.next;
  }
  if (head !== null) points.drop(head);
  points.collect();
  return (sum + Math.imul(bad, 1000000)) | 0;
}

/** Points made and dropped in turn, so each comes off its list again, read back each time. */
export function reuse(k: i32): i32 {
  let bad: i32 = 0;
  let sum: i32 = 0;
  for (let i: i32 = 0; i < k; i++) {
    const five = Math.imul(i, 5);
    const seven = Math.imul(i, 7);
    const p = points.make(new Point(five, -i, 99));
    const q = points.make(new Point(-i, seven, 100));
    if (p.x !== five || p.y !== -i || p.tag !== 99 || q.x !== -i || q.y !== seven || q.tag !== 100)
      bad++;
    sum = (sum + p.x + q.y) | 0;
    points.drop(p);
    points.drop(q);
  }
  points.collect();
  return (sum + Math.imul(bad, 1000000)) | 0;
}

/** Words of lengths that change from one to the next, their tails zero when made, their fields as made; then written. */
export function tails(k: u32, m: u32): i32 {
  let bad: i32 = 0;
  let sum: i32 = 0;
  for (let j: u32 = 0; j < k; j++) {
    const n = 1 + (wrapU32(Math.imul(toI32(j), 37)) % m);
    const id = Math.imul(toI32(j), 3) + 1;
    const w = words.makeTail(toUsize(n), new Word(id));
    if (w.id !== id || w.first !== 7 || toU32(w.units.length) !== n) bad++;
    for (let i: usize = 0; i < w.units.length; i++) if (w.units[i]! !== 0) bad++;
    for (let i: usize = 0; i < w.units.length; i++) w.units[i] = wrapU16(toI32(i) + w.id);
    sum = (sum + toI32(w.units[w.units.length - 1]!)) | 0;
    w.first = j;
    words.drop(w);
  }
  words.collect();
  return (sum + Math.imul(bad, 1000000)) | 0;
}

/** Many words kept, so fresh slots are cut and fresh pages taken, each read back; then all dropped. */
export function kept(k: u32): i32 {
  let bad: i32 = 0;
  let head: Counted<Point> | null = null;
  for (let j: u32 = 0; j < k; j++) {
    const n = 3 + (j % 40);
    const w = words.makeTail(toUsize(n), new Word(toI32(j)));
    w.units[0] = wrapU16(toI32(j));
    const p = points.make(new Point(toI32(w.units[0]!), toI32(n), j));
    if (p.x !== toI32(j & 0xffff) || p.y !== toI32(n) || p.tag !== j || w.id !== toI32(j)) bad++;
    p.next = head;
    head = p;
    words.drop(w);
  }
  let count: i32 = 0;
  let at = head;
  while (at !== null) {
    count++;
    at = at.next;
  }
  if (head !== null) points.drop(head);
  points.collect();
  words.collect();
  return (count + Math.imul(bad, 1000000) + Math.imul(toI32(points.size + words.size), 1000)) | 0;
}
