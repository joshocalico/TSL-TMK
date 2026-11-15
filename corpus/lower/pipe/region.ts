// memory-pages: 64
// R6: tslc's per-call region (D62's third ruling, SPEC 3.5 and 4.5, compiler/host/region.ts). What no export call outlives
// goes in the region, which each export gives back when it returns; what can outlive one (module state, a result, what's
// stored into an argument, a closure kept) stays in the mode's heap. Each export here keeps or churns something, and the
// cases call them in an order that reads, in a later call, what an earlier one kept, after calls that churn far more than
// the 64 pages hold, so an object put in the region that a later call reads is overwritten by then.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
class Tmp {
  a = 0;
  b = 0;
  kids: Tmp[] = [];
  constructor(public v: number) {}
}
class Item {
  constructor(
    public id: number,
    public w: number,
  ) {}
}
type Box = { items: Item[]; total: number };

let kept: Node | null = null;
let handler: (() => number) | null = null;
const log: number[] = [];

export function keep(n: number): number {
  for (let i = 0; i < (n | 0); i++) {
    const k = new Node(i);
    k.next = kept;
    kept = k;
  }
  return n | 0;
}

export function readKept(): number {
  let t = 0;
  for (let p = kept; p !== null; p = p.next) t = (t + p.v + 1) | 0;
  return t;
}

export function keepHandler(k: number): number {
  const base = new Node(k);
  handler = (): number => base.v * 2;
  return k;
}

export function callHandler(): number {
  return handler === null ? -1 : handler();
}

/** Objects and arrays made and dropped in a loop: far more than 64 pages over a call. */
export function churn(n: number, m: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const r = new Tmp(i);
    for (let j = 0; j < (m | 0); j++) {
      const c = new Tmp(j);
      c.a = i + j;
      r.kids.push(c);
    }
    t = (t + r.kids.length + r.kids[0]!.a) | 0;
  }
  log.push(t);
  return t;
}

function chain(len: number, seed: number): Tmp {
  const first = new Tmp(seed);
  let last = first;
  for (let i = 1; i < len; i++) {
    const c = new Tmp(seed + i);
    last.kids.push(c);
    last = c;
  }
  return first;
}

/** What an internal function gives back, used and dropped within the call. */
export function chains(n: number, len: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + chain(len | 0, i).kids.length) | 0;
  return t;
}

export function makeList(n: number): Node | null {
  let head: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const k = new Node(i * 3);
    k.next = head;
    head = k;
  }
  return head;
}

export function fill(b: Box, n: number): number {
  for (let i = 0; i < (n | 0); i++) {
    b.items.push(new Item(i, i * 0.5));
    b.total += i * 0.5;
  }
  return b.items.length;
}

/** An array grown far past its first buffer, then dropped. */
export function grow(n: number): number {
  const xs: Tmp[] = [];
  for (let i = 0; i < (n | 0); i++) xs.push(new Tmp(i));
  let t = 0;
  for (const x of xs) t = (t + x.v) | 0;
  return t;
}

export function logged(): number[] {
  return log.slice();
}

/** An export called from another: what the inner call made is given back as it returns, what it gave back kept. */
export function outer(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + churn(4, 8)) | 0;
  return t;
}
