// A constructor leaves out its stores of zero initialisers, because every object it runs on starts zeroed (SPEC 3.5, zeroed
// construction). Each case dirties memory that a later object of the same class is built in or copied over, a reused Slab
// slot, a reused Rc slot, a stack object in a loop, and reads the zero fields back; and a class built in place inside
// another keeps its stores. The same program on V8, JSC and natively.
import { type bool, type f64, type u32, type u64, type usize } from "@tsl/core";
import { Rc, Visit } from "@tsl/gc";
import { Slab } from "@tsl/std";

class Cell {
  a: u32 = 0;
  b: f64 = 0;
  on: bool = false;
  big: u64 = 0n;
  constructor(public id: u32) {}
}

function dirty(c: Cell): void {
  c.a = 0xdead;
  c.b = -1.5;
  c.on = true;
  c.big = 77n;
}

function zero(c: Cell): bool {
  return c.a === 0 && c.b === 0 && !c.on && c.big === 0n;
}

/** Each add takes the slot the last remove gave back, dirtied: its object reads zero all the same. */
export function slabReuse(rounds: u32): u32 {
  const s = new Slab<Cell>();
  let bad: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const c = s.add(new Cell(i));
    if (!zero(c) || c.id !== i) bad++;
    dirty(c);
    s.remove(c);
  }
  return bad;
}

/** One stack slot, dirtied each time round, built in again by the next iteration's new. */
export function stackReuse(rounds: u32): u32 {
  let bad: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const c = new Cell(i);
    if (!zero(c) || c.id !== i) bad++;
    dirty(c);
  }
  return bad;
}

class Counter {
  n: u32 = 0;
  flag: bool = false;
  constructor(public id: u32) {}
}

function releaseCounter(_c: Counter, _at: usize, _op: Visit): usize {
  return 0;
}

const counters = new Rc<Counter>(releaseCounter);

/** An Rc slot freed with its fields dirtied, and reused by the next make. */
export function rcReuse(rounds: u32): u32 {
  let bad: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const h = counters.make(new Counter(i));
    if (h.n !== 0 || h.flag || h.id !== i) bad++;
    h.n = 9;
    h.flag = true;
    counters.drop(h);
    counters.collect();
  }
  return bad;
}

class Inner {
  x: u32 = 0;
  constructor(public y: u32) {}
}

class Outer {
  inner = new Inner(3);
  z: u32 = 0;
}

/** Built in place inside another object: Inner keeps its stores. */
export function inPlace(rounds: u32): u32 {
  let sum: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const o = new Outer();
    sum += o.inner.x + o.inner.y + o.z;
    o.inner.x = 5;
    o.z = 6;
  }
  return sum;
}
