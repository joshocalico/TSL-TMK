// memory-pages: 96
// @tsl/gc's Rc counting objects with a tail (D69), in a strict package: `makeTail(n, new T())` gives each object a slot of
// its real size, by size class, and a freed slot is reused only for an object of the same store and size class. Strings of
// many lengths, sharing and dropping, a release dropping what an object holds, nothing left after collect, and a churn that
// fits only if freed slots are reused. The same program on V8, JSC and natively.
import {
  tail,
  toI32,
  toU32,
  toUsize,
  u16,
  wrapU16,
  type i32,
  type u32,
  type usize,
} from "@tsl/core";
import { Rc, Visit, type Counted } from "@tsl/gc";

class Text {
  next: Counted<Text> | null = null;
  constructor(public id: u32) {}
  units = tail(u16);

  sum(): i32 {
    let t: i32 = 0;
    for (let i: usize = 0; i < this.units.length; i++) t += this.units[i]!;
    return t;
  }
}

function releaseText(t: Text, at: usize, op: Visit): usize {
  const next = t.next;
  if (at === 0 && next !== null) texts.visit(next, op);
  return 1;
}

const texts = new Rc<Text>(releaseText);

function text(id: u32, n: u32): Counted<Text> {
  const t = texts.makeTail(toUsize(n), new Text(id));
  for (let i: usize = 0; i < t.units.length; i++) t.units[i] = wrapU16(toI32(i) + 1);
  return t;
}

/** Texts of lengths 0 to k - 1 chained, summed, dropped from the head: none left once collected. */
export function chain(k: u32): i32 {
  texts.collect();
  const base = texts.size;
  let head: Counted<Text> | null = null;
  for (let j: u32 = 0; j < k; j++) {
    const t = text(j, j);
    t.next = head;
    head = t;
  }
  let total: i32 = 0;
  let at = head;
  while (at !== null) {
    total += at.sum() + toI32(at.units.length) * 1000;
    at = at.next;
  }
  if (head !== null) texts.drop(head);
  texts.collect();
  return total * 10 + toI32(texts.size - base);
}

/** A shared text stays until its last count goes. */
export function shared(n: u32): i32 {
  texts.collect();
  const base = texts.size;
  const a = text(7, n);
  const b = texts.share(a);
  const c1 = toI32(texts.count(b));
  texts.drop(a);
  texts.collect();
  const still = b.sum();
  const live = toI32(texts.size - base);
  texts.drop(b);
  texts.collect();
  return c1 * 10000000 + still * 10 + live + toI32(texts.size - base) * 100;
}

/**
 * k rounds of a text of a length that cycles through m sizes, each zeroed when made and dropped at once: a slot freed is
 * reused for the next of its size class, so this fits in 96 pages however large k is. Gives the bad elements seen.
 */
export function churn(k: u32, m: u32): i32 {
  texts.collect();
  let bad: i32 = 0;
  for (let j: u32 = 0; j < k; j++) {
    const n = 100 + (j % m) * 300;
    const t = texts.makeTail(toUsize(n), new Text(j));
    for (let i: usize = 0; i < t.units.length; i++) if (t.units[i]! !== 0) bad++;
    for (let i: usize = 0; i < t.units.length; i++) t.units[i] = 0xffff;
    if (t.id !== j || toU32(t.units.length) !== n) bad++;
    texts.drop(t);
  }
  texts.collect();
  return bad * 1000 + toI32(texts.size);
}
