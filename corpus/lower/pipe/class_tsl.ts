// Phase 2's first printing (D62's rulings): objects as TSL classes. A hierarchy is one class with a class-id field and
// switch dispatch, `instanceof` an id test, a list through a nullable field, a field of the class's own type that's never
// null, and module state as TSL globals. No arrays, strings or closures, which this printing doesn't take yet.
class Shape {
  scale: number;
  next: Shape | null = null;
  constructor(scale: number) {
    this.scale = scale;
  }
  area(): number {
    return 0;
  }
  weight(): number {
    return this.area() * this.scale;
  }
}

class Square extends Shape {
  side: number;
  constructor(side: number, scale: number) {
    super(scale);
    this.side = side;
  }
  override area(): number {
    return this.side * this.side;
  }
}

class Rect extends Shape {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    super(2);
    this.w = w;
    this.h = h;
  }
  override area(): number {
    return this.w * this.h;
  }
}

class Tall extends Rect {
  constructor(w: number) {
    super(w, w * 3);
  }
  override area(): number {
    return super.area() + 1;
  }
  override weight(): number {
    return -super.weight();
  }
}

class Pair {
  left: Pair;
  value: number;
  active = false;
  constructor(value: number) {
    this.value = value;
    this.left = this;
  }

  /** Down the chain n steps from this one: a local that starts as `this` and moves on. */
  sumDown(n: number): number {
    let p: Pair = this;
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += p.value;
      p = p.left;
    }
    return s;
  }
}

let made = 0;
let last: Shape | null = null;

function make(k: number): Shape {
  made++;
  let s: Shape;
  if (k === 0) s = new Square(3, 1);
  else if (k === 1) s = new Rect(2, 5);
  else if (k === 2) s = new Tall(2);
  else s = new Shape(7);
  last = s;
  return s;
}

export function areaOf(k: number): number {
  return make(k).area();
}

export function weightOf(k: number): number {
  return make(k).weight();
}

/** A list of shapes through `next`, built and walked, with each kind counted by instanceof. */
export function listOf(n: number): number {
  let head: Shape | null = null;
  for (let i = 0; i < n; i++) {
    const s = make(i % 4);
    s.next = head;
    head = s;
  }
  let sum = 0;
  let squares = 0;
  let rects = 0;
  for (let p = head; p !== null; p = p.next) {
    sum += p.weight();
    if (p instanceof Square) squares++;
    if (p instanceof Rect) rects++;
  }
  return sum * 10000 + squares * 100 + rects;
}

/** Module state: how many were made, and the last one's area, through a global holding a reference. */
export function madeSoFar(n: number): number {
  for (let i = 0; i < n; i++) make(i % 3);
  const l = last;
  return made * 1000 + (l === null ? -1 : l.area());
}

/** A pair whose `left` is itself to begin with, then a chain of them; a boolean field. */
export function pairs(n: number): number {
  let p = new Pair(0);
  for (let i = 1; i <= n; i++) {
    const q = new Pair(i);
    q.left = p;
    q.active = i % 2 === 0;
    p = q;
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (p.active) count++;
    sum += p.value;
    p = p.left;
  }
  return sum * 100 + count + (p.left === p ? 1 : 0);
}

/** A chain of n, walked from its last by a method whose local starts as `this` (pipe-h). */
export function walkDown(n: number): number {
  let p = new Pair(0);
  for (let i = 1; i <= n; i++) {
    const q = new Pair(i * 3);
    q.left = p;
    p = q;
  }
  return p.sumDown(n + 2);
}
