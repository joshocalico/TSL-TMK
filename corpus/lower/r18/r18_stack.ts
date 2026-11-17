// R18: objects `rc` class printing keeps on the stack, as the direct route does, beside objects it counts, for the dual route
// with class printing forced. A class every object of which stays in the function that made it, holding numbers alone, is
// kept on the stack (`@tsl.stack`): made, passed down to helpers that read and write it, chosen between on a branch, made
// in a recursion's every frame, and alive while counted objects are made, dropped, put in cycles and collected around it.
// A class one of whose objects escapes (into module state, a counted object's field, an array, a result, a loop's later
// turn) is counted, every object of it; so is one whose objects are made in a loop. A wrong placement shows as a wrong
// result: a stack object read after its frame, or freed by @tsl/gc while its frame still uses it.
class Pt {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

class Acc {
  sum = 0;
  n = 0;
  ok = true;
  // A stack class's methods are expanded as any function is: the link it stores in a counted object is counted.
  link(a: Node, b: Node): void {
    a.next = b;
    this.n = this.n + 1;
  }
}

// An object stored in another's field, both made in one frame: the direct route counts both (the stored one escapes its
// variable), and so does class printing, which keeps on the stack only what the lowering does.
class Mark {
  constructor(public v: number) {}
}
class Span {
  lo: Mark | null = null;
  hi: Mark | null = null;
}

// Kept: every object stays where it's made. Escapes: one goes into module state, so all are counted.
class Kept {
  constructor(public v: number) {}
}
class Escapes {
  constructor(public v: number) {}
}

class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}

// Inner's objects are held by a counted object in module state, which can be in a cycle the collector scans: counted.
class Inner {
  constructor(public v: number) {}
}
class Box {
  inner: Inner | null = null;
  next: Box | null = null;
}

let lastEscaped: Escapes | null = null;
const box = new Box();

function norm1(p: Pt): number {
  return Math.abs(p.x) + Math.abs(p.y);
}

function shift(p: Pt, dx: number): void {
  p.x = p.x + dx;
  p.y = p.y - dx;
}

function add(a: Acc, v: number): void {
  a.sum = (a.sum + v) | 0;
  a.n = a.n + 1;
  if (v < 0) a.ok = false;
}

/** A stack object made, passed down to helpers that read and write it. */
export function passDown(x: number, y: number): number {
  const p = new Pt(x | 0, y | 0);
  shift(p, 3);
  const a = norm1(p);
  shift(p, -1);
  return a * 1000 + norm1(p);
}

/** One of two stack objects chosen on a branch, then the other written through the choice. */
export function chosen(k: number): number {
  const a = new Pt(1, 2);
  const b = new Pt(10, 20);
  const c = (k | 0) % 2 === 0 ? a : b;
  shift(c, k | 0);
  return a.x * 1000000 + a.y * 10000 + b.x * 100 + b.y;
}

/** A stack object in each frame of a recursion, each read after the calls below it returned. */
function depth(n: number, acc: Acc): number {
  const p = new Pt(n, n * 2);
  add(acc, n);
  if (n <= 0) return norm1(p);
  const below = depth(n - 1, acc);
  return below + p.x - p.y + norm1(p);
}

export function recursion(n: number): number {
  const acc = new Acc();
  const r = depth(n | 0, acc);
  return r * 1000 + acc.sum + acc.n * 7 + (acc.ok ? 1 : 0);
}

/** Counted objects made, dropped and put in cycles while a stack object is alive: freeing and the collector run around it. */
export function amidChurn(n: number): number {
  const acc = new Acc();
  const p = new Pt(5, 7);
  let keep: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const a = new Node(i);
    const b = new Node(i + 1);
    acc.link(a, b);
    b.next = a; // a cycle, dropped at the end of the turn
    if (i % 3 === 0) {
      const c = new Node(i * 2);
      if (keep !== null) acc.link(c, keep);
      keep = c;
    }
    add(acc, a.v + b.v);
    shift(p, 1);
  }
  let walk = 0;
  for (let q = keep; q !== null; q = q.next) walk = (walk + q.v) | 0;
  return acc.sum + acc.n * 3 + norm1(p) * 100000 + walk * 7;
}

/** A class kept on the stack beside one counted because an object of it escapes into module state. */
export function keptAndEscaped(v: number): number {
  const k = new Kept(v | 0);
  const e = new Escapes((v | 0) + 1);
  lastEscaped = e;
  return k.v * 10 + e.v;
}

export function readEscaped(): number {
  return lastEscaped === null ? -1 : lastEscaped.v;
}

/** Objects made in a loop: counted, as the direct route counts them, each turn's freed while the next is made. */
export function inLoop(n: number): number {
  let s = 0;
  for (let i = 0; i < (n | 0); i++) {
    const p = new Kept(i);
    s = (s + p.v * 3) | 0;
  }
  return s;
}

/** A stack object whose fields are read after calls that make and drop counted objects. */
export function afterCalls(n: number): number {
  const p = new Pt(n | 0, 1);
  const a = inLoop(n | 0);
  const b = amidChurn(3);
  shift(p, 2);
  return p.x * 100000 + p.y + ((a + b) % 1000);
}

/** An object held by a counted one past the call that made it, read in a later call, with a cycle through its holder. */
export function setInner(v: number): number {
  box.inner = new Inner(v | 0);
  box.next = box;
  return box.inner.v;
}

export function readInner(n: number): number {
  const p = new Pt(n | 0, 2);
  shift(p, 1);
  const r = box.inner === null ? -1 : box.inner.v;
  box.next = null;
  return r * 1000 + norm1(p);
}

/** An object holding two others, all made in one frame, read through it after one was written. */
export function span(a: number, b: number): number {
  const lo = new Mark(a | 0);
  const hi = new Mark(b | 0);
  const s = new Span();
  s.lo = lo;
  s.hi = hi;
  s.hi.v = s.hi.v + 2;
  return s.hi.v * 1000 + s.lo.v + (s.lo === lo ? 7 : 0);
}
