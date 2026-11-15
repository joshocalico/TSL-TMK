// What a person writes in an `rc` package (SPEC 3.5, D74), each form the expansion has a rule for: parameter properties
// and field initialisers holding counted objects, vectors of counted references in fields, closures given borrows, a
// class with a tail, getters, conditionals, nullable results, globals, and two modules (rc_shapes.ts holds the shapes).
import {
  tail,
  toI32,
  toU32,
  toUsize,
  u16,
  wrapU16,
  withTail,
  type bool,
  type i32,
  type u32,
  type usize,
} from "@tsl/core";
import { rcCollect, rcLive } from "@tsl/gc";
import { ref, Vec } from "@tsl/std";
import { Circle, Group, Square, total } from "./rc_shapes.ts";

class Pair {
  constructor(
    public left: Leaf,
    public right: Leaf | null,
  ) {}

  get weight(): u32 {
    return this.left.w + (this.right === null ? 0 : this.right.w);
  }
}

class Leaf {
  constructor(public w: u32) {}
}

class Tree {
  root = new Leaf(1);
  kids = new Vec(ref<Tree>());
  constructor(public id: u32) {}

  add(t: Tree): void {
    this.kids.push(t);
  }

  size(): u32 {
    let n: u32 = 1;
    this.kids.forEach((k) => {
      n += k.size();
    });
    return n;
  }
}

class Text {
  constructor(public id: u32) {}
  units = tail(u16);

  sum(): i32 {
    let s: i32 = 0;
    for (let i: usize = 0; i < this.units.length; i++) s += this.units[i]!;
    return s;
  }
}

let last: Pair | null = null;

function settle(): usize {
  rcCollect();
  return rcLive();
}

/** Parameter properties take their own counts; a getter reads through them. */
export function pairs(n: u32): u32 {
  const base = settle();
  let w: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const a = new Leaf(i);
    const p = new Pair(a, i % 2 === 0 ? null : new Leaf(1));
    w += p.weight;
    last = p;
  }
  const keep = last!.weight;
  last = null;
  return w * 1000 + keep + (settle() === base ? 0 : 500);
}

function build(depth: u32, id: u32): Tree {
  const t = new Tree(id);
  if (depth > 0) for (let i: u32 = 0; i < 3; i++) t.add(build(depth - 1, id * 3 + i));
  return t;
}

/** A tree of vectors: built, counted through a closure, dropped, all freed. */
function treesIn(depth: u32): u32 {
  const t = build(depth, 1);
  return t.size();
}

export function trees(depth: u32): u32 {
  const base = settle();
  const n = treesIn(depth);
  return n * 10 + (settle() === base ? 0 : 1);
}

/** Vector operations moving counts in and out: set replaces, removeAt and swapRemove give owned values, clear drops. */
function vectorsIn(n: u32): u32 {
  const t = new Tree(0);
  for (let i: u32 = 0; i < n; i++) t.add(new Tree(i));
  t.kids.set(0, new Tree(100));
  t.kids.insert(1, t.kids.get(2));
  const r = t.kids.removeAt(3);
  const s = t.kids.swapRemove(0);
  let ids: u32 = r.id * 1000 + s.id;
  t.kids.forEach((k) => {
    ids += k.id;
  });
  t.kids.clear();
  const left = toU32(t.kids.length);
  return ids * 10 + left;
}

export function vectors(n: u32): u32 {
  const base = settle();
  const r = vectorsIn(n);
  return r * 10 + (settle() === base ? 0 : 7);
}

function text(id: u32, n: usize): Text {
  const t = withTail(n, new Text(id));
  for (let i: usize = 0; i < t.units.length; i++) t.units[i] = wrapU16(toI32(i) + 1);
  return t;
}

/** Objects with a tail, made with withTail: counted at their real size. */
export function tails(n: u32): i32 {
  const base = settle();
  let s: i32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    const t = text(i, toUsize(i % 40));
    s += t.sum();
  }
  return s * 10 + (settle() === base ? 0 : 1);
}

/** A choice between counted values, owned and borrowed. */
function pick(a: Leaf, b: Leaf | null, first: bool): Leaf {
  return first || b === null ? a : b;
}

function chooseIn(n: u32): u32 {
  const a = new Leaf(n);
  const b = new Leaf(n + 1);
  const x = pick(a, b, false);
  const y = pick(a, null, false);
  const z = n > 3 ? new Leaf(9) : a;
  return x.w * 10000 + y.w * 100 + z.w;
}

export function choose(n: u32): u32 {
  const base = settle();
  const r = chooseIn(n);
  return r * 10 + (settle() === base ? 0 : 1);
}

/** Shapes from another module, counted by their own module's stores. */
function shapesIn(n: u32): u32 {
  const g = new Group();
  for (let i: u32 = 0; i < n; i++) {
    g.circles.push(new Circle(i));
    g.squares.push(new Square(i + 1));
  }
  return total(g);
}

export function shapes(n: u32): u32 {
  const base = settle();
  const r = shapesIn(n);
  return r * 10 + (settle() === base ? 1 : 0);
}
