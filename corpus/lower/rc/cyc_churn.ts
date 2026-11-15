// memory-pages: 96
// Far more cycles made and dropped than 96 pages hold, with a small live set. With the collector off, each of these traps
// 14 under this limit, and with it on each completes, with the same result as V8 (SPEC 3.5, D41, M5 Phase E).
class Self {
  me: Self | null = null;
  constructor(public v: number) {}
}
class Two {
  other: Two | null = null;
  constructor(public v: number) {}
}
class RingNode {
  next: RingNode | null = null;
  constructor(public v: number) {}
}
class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: number) {}
}
class Box {
  op: () => number;
  constructor(public k: number) {
    this.op = (): number => this.k;
  }
}
class Tree {
  parent: Tree | null = null;
  kids: Tree[] = [];
  constructor(public v: number) {}
}
let global: RingNode | null = null;

export function selfLoops(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const s = new Self(i);
    s.me = s;
    t = (t + s.me.v) | 0;
  }
  return t;
}
export function twoNodes(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = new Two(i);
    const b = new Two(i + 1);
    a.other = b;
    b.other = a;
    t = (t + a.other.v) | 0;
  }
  return t;
}
function ring(len: number, seed: number): RingNode {
  const first = new RingNode(seed);
  let last = first;
  for (let i = 1; i < len; i++) {
    const r = new RingNode(seed + i);
    last.next = r;
    last = r;
  }
  last.next = first;
  return first;
}
export function rings(n: number, len: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const r = ring(len | 0, i);
    t = (t + r.next!.v) | 0;
  }
  return t;
}
export function doublyLinked(n: number, len: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const head = new Link(i);
    let last = head;
    for (let j = 1; j < (len | 0); j++) {
      const c = new Link(j);
      c.prev = last;
      last.next = c;
      last = c;
    }
    t = (t + last.prev!.v) | 0;
  }
  return t;
}
export function thisClosures(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + new Box(i).op()) | 0;
  return t;
}
export function closuresInArrays(n: number, m: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a: (() => number)[] = [];
    for (let j = 0; j < (m | 0); j++) a.push((): number => a.length + j);
    t = (t + a[0]!()) | 0;
  }
  return t;
}
function tree(depth: number, v: number): Tree {
  const r = new Tree(v);
  if (depth > 0) {
    for (let i = 0; i < 2; i++) {
      const k = tree(depth - 1, v + i);
      k.parent = r;
      r.kids.push(k);
    }
  }
  return r;
}
export function parentTrees(n: number, depth: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const r = tree(depth | 0, i);
    t = (t + r.kids.length + r.kids[0]!.parent!.v) | 0;
  }
  return t;
}
export function viaGlobal(n: number, len: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    global = ring(len | 0, i);
    t = (t + global.next!.v) | 0;
    global = null;
  }
  return t;
}
