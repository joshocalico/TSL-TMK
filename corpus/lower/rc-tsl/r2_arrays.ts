// memory-pages: 96
// Arrays of counted objects in `rc` (R2), each churned far past the memory there is (96 pages, 384 KiB): an element, an
// array or a buffer that isn't freed runs out (trap 14). Through the direct route and printed as TSL, where each array is
// held by a class of the program's own and its elements are counted by tslc's expansion onto @tsl/gc (D74).
class Item {
  next: Item | null = null;
  constructor(public v: number) {}
}

class Bag {
  items: Item[] = [];
  nums: number[] = [];
  constructor(public tag: number) {}
}

let kept: Item[] = [];
let bag: Bag | null = null;
let grid: Item[][] = [];

/** Elements overwritten in place: each old one has to go. */
export function overwrite(rounds: number): number {
  const a: Item[] = [];
  for (let i = 0; i < 8; i++) a.push(new Item(i));
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    a[r & 7] = new Item(r);
    t = (t + a[r & 7]!.v) | 0;
  }
  return t;
}

/** A shorter length drops what it cuts off; pop and shift move elements out. */
export function cutAndMove(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a: Item[] = [];
    for (let i = 0; i < 16; i++) a.push(new Item(i + r));
    a.length = 4;
    const last = a.pop();
    const first = a.shift();
    t = (t + (last?.v ?? 0) + (first?.v ?? 0) + a.length) | 0;
  }
  return t;
}

/** An array in a global, replaced each round: the old one and everything in it go. */
export function globalArrays(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a: Item[] = [];
    for (let i = 0; i < 32; i++) a.push(new Item(i));
    kept = a;
    t = (t + kept.length + kept[31]!.v) | 0;
  }
  kept = [];
  return t;
}

/** Arrays in an object's fields, of objects and of numbers, freed with it. */
export function fieldArrays(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const b = new Bag(r);
    for (let i = 0; i < 24; i++) {
      b.items.push(new Item(i));
      b.nums.push(i * 2);
    }
    bag = b;
    t = (t + b.items[23]!.v + b.nums[23]! + b.tag) | 0;
  }
  bag = null;
  return t;
}

/** Arrays of arrays, and holes. */
export function nested(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const g: Item[][] = [];
    for (let i = 0; i < 6; i++) {
      const row: Item[] = [];
      row[3] = new Item(i);
      g.push(row);
    }
    grid = g;
    t = (t + grid[5]![3]!.v + (grid[2]![1] === undefined ? 1 : 0)) | 0;
  }
  grid = [];
  return t;
}

/** Numbers only: the buffers alone have to go back. */
export function numbers(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a: number[] = [];
    for (let i = 0; i < 200; i++) a.push(i);
    t = (t + a[199]!) | 0;
  }
  return t;
}

/** Something does run out: an array that only grows. */
export function reallyOut(n: number): number {
  const a: Item[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(new Item(i));
  return a.length;
}

/** Linked through arrays: a list whose nodes hold their successor in an array of one. */
class Hop {
  out: Hop[] = [];
  constructor(public v: number) {}
}

export function chains(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    let head: Hop | null = null;
    for (let i = 0; i < 20; i++) {
      const h = new Hop(i);
      if (head !== null) h.out.push(head);
      head = h;
    }
    let n = 0;
    for (let p: Hop | null = head; p !== null; p = p.out.length > 0 ? p.out[0]! : null) n++;
    t = (t + n) | 0;
  }
  return t;
}
