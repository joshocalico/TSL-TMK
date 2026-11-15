// R5 (SPEC 4.5's native ABI, D36): objects and arrays crossing an export through the TSL route, laid out as D36 lists them.
// Booleans side by side and before wider fields, where D36's slot is 4 bytes and TSL's bool 1 (the printing pads them);
// fields whose source order isn't D36's; i32, u32 and f64; nested objects, nulls, arrays of objects and of numbers, an
// argument written through, an argument kept past the call, a class with a method, and a shared object read back as one.
type Flags = { a: boolean; b: boolean; n: number; c: boolean; x: number };
type Node = { v: number; next: Node | null; hit: boolean };
type Bag = { items: Node[]; total: number; nums: number[] };

class Counter {
  on = false;
  count = 0;
  scale = 1.5;
  bump(by: number): number {
    if (this.on) this.count = (this.count + by) | 0;
    return this.count * this.scale;
  }
}

let kept: Node | null = null;

export function flags(n: number): Flags {
  return { a: n > 0, b: n > 1, n: n | 0, c: n > 2, x: n * 0.5 };
}

export function readFlags(f: Flags): number {
  return (f.a ? 1 : 0) + (f.b ? 2 : 0) + (f.c ? 4 : 0) + f.n * 8 + f.x;
}

export function flip(f: Flags): Flags {
  f.a = !f.a;
  f.c = !f.c;
  f.n = (f.n + 1) | 0;
  return f;
}

export function chain(len: number): Node | null {
  let head: Node | null = null;
  for (let i = 0; i < (len | 0); i++) head = { v: i, next: head, hit: (i & 1) === 1 };
  return head;
}

export function sumChain(h: Node | null): number {
  let t = 0;
  for (let p = h; p !== null; p = p.next) t += p.hit ? p.v * 2 : p.v;
  return t;
}

export function markAll(h: Node | null): number {
  let n = 0;
  for (let p = h; p !== null; p = p.next) {
    p.hit = true;
    n++;
  }
  return n;
}

export function keep(n: Node): number {
  kept = n;
  return n.v;
}

export function readKept(): Node | null {
  return kept;
}

export function bag(n: number): Bag {
  const items: Node[] = [];
  const nums: number[] = [];
  let total = 0;
  for (let i = 0; i < (n | 0); i++) {
    items.push({ v: i * 3, next: null, hit: i === 0 });
    nums.push(i * 1.25);
    total += i;
  }
  return { items, total, nums };
}

export function bagTotal(b: Bag): number {
  let t = b.total;
  for (const it of b.items) t += it.v + (it.hit ? 100 : 0);
  for (const x of b.nums) t += x;
  return t;
}

export function grow(b: Bag, by: number): number {
  for (let i = 0; i < (by | 0); i++) {
    b.items.push({ v: -i, next: null, hit: false });
    b.nums.push(i);
  }
  b.total = b.items.length;
  return b.items.length + b.nums.length;
}

export function nodesOf(xs: number[]): Node[] {
  const out: Node[] = [];
  for (const x of xs)
    out.push({ v: x, next: out.length > 0 ? out[out.length - 1]! : null, hit: x > 2 });
  return out;
}

export function counter(on: boolean, by: number): Counter {
  const c = new Counter();
  c.on = on;
  c.bump(by);
  c.bump(by);
  return c;
}

export function bumpTwice(on: boolean, by: number): number {
  const c = counter(on, by);
  return c.bump(by) + (c.on ? 1 : 0);
}

export function shared(): Node[] {
  const one: Node = { v: 9, next: null, hit: true };
  return [one, one, { v: 1, next: one, hit: false }];
}
