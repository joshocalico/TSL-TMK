// memory-pages: 96
// Closures as values in `rc` (R3), each churned far past the memory there is (96 pages, 384 KiB): an environment, or what one
// captures, that isn't freed runs out (trap 14), and a closure over its own holder is a cycle only the collector frees.
// Through the direct route and printed as TSL, where each flow class of closure values is an environment class with a kind
// field where several closures reach it, and its call a method picking the kind's (D74's expansion counts it as a class).
class Node {
  op: () => number;
  constructor(public v: number) {
    this.op = (): number => this.v + 1; // over `this`: Node -> environment -> Node
  }
}

class Holder {
  inc: () => number = (): number => 0;
  get: () => number = (): number => 0;
}

class Cell {
  v = 0;
  f: () => number = (): number => -1;
}

let saved: (() => number)[] = [];

/** Closures of one flow class, of four kinds: two captures of one type in one closure, an object, and nothing. */
export function kinds(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const a = r & 15;
    const b = (r >> 4) & 15;
    const n = new Node(r);
    const fs: ((x: number) => number)[] = [];
    fs.push((x: number): number => x * a + b);
    fs.push((x: number): number => x - b * 3 - a);
    fs.push((x: number): number => x + n.v);
    fs.push((x: number): number => x);
    for (let i = 0; i < fs.length; i++) t = (t + fs[i]!(i + 1)) | 0;
  }
  return t;
}

/** A closure over `this`, kept in a field: each node is a cycle with its environment. */
export function selfCycles(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const n = new Node(r);
    t = (t + n.op()) | 0;
  }
  return t;
}

/** Two closures sharing a captured variable that changes: a cell both environments hold. */
export function sharedCounter(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    let count = r & 7;
    const h = new Holder();
    h.inc = (): number => ++count;
    h.get = (): number => count * 2;
    h.inc();
    count += 3;
    t = (t + h.get()) | 0;
  }
  return t;
}

/** A closure stored in the object it captures (not `this`): a cycle through a field. */
export function cellCycles(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const c = new Cell();
    c.v = r & 255;
    c.f = (): number => c.v * 2;
    t = (t + c.f()) | 0;
  }
  return t;
}

/** Closures kept past the iteration that made them, in a module-level array that's replaced now and then. */
export function keptAWhile(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const n = new Node(r & 1023);
    saved.push(n.op);
    t = (t + saved[saved.length - 1]!() + saved[0]!()) | 0;
    if (saved.length > 8) saved = [];
  }
  saved = [];
  return t;
}

/** Every closure kept: this one does run out, as V8 would if it had 384 KiB. */
export function reallyOut(rounds: number): number {
  let t = 0;
  for (let r = 0; r < (rounds | 0); r++) {
    const n = new Node(r);
    saved.push(n.op);
    t = (t + saved.length) | 0;
  }
  return t;
}
