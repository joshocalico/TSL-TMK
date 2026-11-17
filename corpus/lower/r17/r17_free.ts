// R17: what `@tsl/gc`'s freeing step and JsArray's "no holes" flag have to get right, for the dual route with class printing
// forced. Freeing: objects with no slots of their own (leaves, freed by giving their block back with no call) waiting
// beside objects with one, two and three references and arrays of them, in every order, so a budget's steps run from the
// leaves' quick path into the general one and back; trees and lists dropped whole while leaves are made. Arrays: an array
// of numbers popped, shifted, cut short and made longer again by writes (it has no holes, so what a shorter length drops
// isn't zeroed, and nothing reads it before it's written again); an array of objects popped and made longer, where JS reads
// a hole, `undefined`, which a slot left holding what it dropped would get wrong; and an array of objects grown into a
// buffer another gave back, whose slots between a write past the end and the rest are holes too.
class Leaf {
  constructor(public v: number) {}
}
class One {
  a: Leaf | null = null;
  constructor(public v: number) {}
}
class Two {
  a: Leaf | null = null;
  b: One | null = null;
  constructor(public v: number) {}
}
class Three {
  a: Leaf | null = null;
  b: Two | null = null;
  c: Leaf | null = null;
  constructor(public v: number) {}
}
class Node {
  next: Node | null = null;
  leaf: Leaf | null = null;
  constructor(public v: number) {}
}

/** Leaves made and dropped at once: each `new` frees the last one. */
function leaves(k: number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s = (s + new Leaf(i).v) | 0;
  return s;
}

/** Objects of every shape made and dropped in turn: the freeing step meets leaves and objects with slots mixed. */
export function mixed(n: number): number {
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    const k = i % 5;
    if (k === 0) s = (s + new Leaf(i).v) | 0;
    else if (k === 1) {
      const o = new One(i);
      o.a = new Leaf(i + 1);
      s = (s + o.v + o.a.v) | 0;
    } else if (k === 2) {
      const t = new Two(i);
      t.a = new Leaf(2);
      t.b = new One(3);
      t.b.a = new Leaf(4);
      s = (s + t.v + t.b.v + t.b.a.v) | 0;
    } else if (k === 3) {
      const t = new Three(i);
      t.a = new Leaf(5);
      t.c = new Leaf(6);
      t.b = new Two(7);
      t.b.b = new One(8);
      s = (s + t.v + t.a.v + t.c.v + t.b.v + t.b.b.v) | 0;
    } else s = (s + leaves(3)) | 0;
  }
  return s;
}

/** A list of n nodes, each holding a leaf, dropped whole; then leaves made while it's freed a budget at a time. */
export function listThenLeaves(n: number): number {
  let head: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const x = new Node(i);
    x.leaf = new Leaf(i * 2);
    x.next = head;
    head = x;
  }
  let s = 0;
  for (let p = head; p !== null; p = p.next) s = (s + p.v + p.leaf!.v) | 0;
  head = null;
  return (s + leaves((n | 0) * 3)) | 0;
}

/** A tree of depth d (each Two holding a leaf and a One), dropped; then objects of each shape made. */
function tree(d: number): Two {
  const t = new Two(d);
  t.a = new Leaf(d);
  t.b = new One(d + 1);
  if (d > 0) {
    const sub = tree(d - 1);
    t.b.a = sub.a;
  }
  return t;
}
export function treeChurn(d: number): number {
  let s = 0;
  for (let r = 0; r < 4; r++) {
    const t = tree(d | 0);
    s = (s + t.v + t.a!.v + t.b!.v) | 0;
    s = (s + mixed(7)) | 0;
  }
  return s;
}

/** Arrays of leaves and of objects with slots, cleared, cut short and refilled while more is made. */
export function arraysOfObjects(n: number): number {
  const a: Leaf[] = [];
  const b: One[] = [];
  for (let i = 0; i < (n | 0); i++) {
    a.push(new Leaf(i));
    const o = new One(i);
    o.a = new Leaf(i + 100);
    b.push(o);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + a[i]!.v + b[i]!.a!.v) | 0;
  a.length = 0;
  b.length = 1;
  s = (s + leaves(40) + b.length) | 0;
  for (let i = 0; i < 5; i++) a.push(new Leaf(i * 7));
  for (let i = 0; i < a.length; i++) s = (s + a[i]!.v) | 0;
  return s;
}

/** Every element of a list of numbers, weighted by its place, with its length. */
function digest(a: number[]): number {
  let s = a.length * 1000003;
  for (let i = 0; i < a.length; i++) s = (s * 31 + a[i]! * (i + 1)) | 0;
  return s;
}

/** Numbers pushed and popped in turn, the popped ones summed: a pop's slot is reused by the next push. */
export function popPush(n: number): number {
  const a: number[] = [];
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    a.push(i * 3 + 1);
    a.push(i * 3 + 2);
    s = (s + (a.pop() ?? -1)) | 0;
  }
  return (s + digest(a)) | 0;
}

/** Numbers popped to empty and past it, then pushed again: what pop dropped is never read back. */
export function popPast(n: number): number {
  const a: number[] = [5, 6, 7, 8, 9];
  let s = 0;
  for (let i = 0; i < (n | 0) + 7; i++) s = (s * 3 + (a.pop() ?? -1)) | 0;
  for (let i = 0; i < (n | 0); i++) a.push(i + 40);
  return (s + digest(a)) | 0;
}

/** Numbers shifted, then the length cut and made longer again by writes, one at the end each time. */
export function shiftCut(n: number): number {
  const a: number[] = [];
  for (let i = 0; i < (n | 0) + 6; i++) a.push(i + 1);
  let s = 0;
  for (let i = 0; i < 3; i++) s = (s + (a.shift() ?? -1)) | 0;
  a.length = 2;
  a[2] = 70;
  a[3] = 71;
  a.push(72);
  return (s + digest(a)) | 0;
}

/** Numbers past a growth after pops: the new room's slots past what it copied are written before they're read. */
export function popThenGrow(n: number): number {
  const a: number[] = [1, 2, 3, 4];
  a.pop();
  a.pop();
  for (let i = 0; i < (n | 0); i++) a.push(i + 10);
  return digest(a);
}

/** Objects popped, then the array made longer: JS reads a hole, `undefined`, where an object was. */
export function objectPopHole(n: number): number {
  const a: Leaf[] = [];
  for (let i = 0; i < (n | 0) + 2; i++) a.push(new Leaf(i + 1));
  const last = a.pop()!;
  a.length = a.length + 1;
  let holes = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === undefined) holes++;
  return holes * 1000 + last.v * 10 + a.length;
}

/** Objects popped, then one written two past the end: the slot between is a hole, as is the one popped. */
export function objectPopWrite(n: number): number {
  const a: Leaf[] = [];
  for (let i = 0; i < (n | 0) + 3; i++) a.push(new Leaf(i + 1));
  a.pop();
  a.pop();
  a[a.length + 1] = new Leaf(99);
  let holes = 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === undefined) holes++;
    else s = (s + x.v) | 0;
  }
  return holes * 100000 + s * 10 + a.length;
}

/**
 * A hole made by a write past the end, after growth into a buffer an earlier array gave back holding objects (in `manual`
 * an outgrown buffer goes back to the allocator, which hands it out again): every slot between reads `undefined`.
 */
export function holeAfterGrowth(n: number): number {
  const big: Leaf[] = [];
  for (let i = 0; i < 9; i++) big.push(new Leaf(i + 1));
  let s = 0;
  for (let i = 0; i < big.length; i++) s = (s + big[i]!.v) | 0;
  const b: Leaf[] = [new Leaf(50)];
  b[(n | 0) + 5] = new Leaf(60);
  let holes = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === undefined) holes++;
  return holes * 1000 + s * 10 + b.length;
}
