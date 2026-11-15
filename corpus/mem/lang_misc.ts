// The rest of what classes and references bring: nullable references, function values, generics, and globals.
import { Heap, Slab, Vec } from "@tsl/alloc";
import {
  make,
  toU32,
  u32 as u32f,
  type bool,
  type f64,
  type i8,
  type Result,
  type u32,
  type u64,
  type u8,
  type usize,
} from "@tsl/core";
import { pages } from "./pages.ts";

const heap = new Heap(pages);

class Node {
  next: Node | null = null;
  constructor(public val: u32) {}
  setVal(v: u32): void {
    this.val = v;
  }
  nextVal(): u32 {
    return (this.next?.next ?? zero).val;
  }
}
const zero = new Node(0);
const nodes = new Slab<Node>(heap, 4);

export function linkedList(n: u32): u32 {
  let head: Node | null = null;
  for (let i: u32 = 1; i <= n; i++) {
    const node: Node = nodes.add(new Node(i))!;
    node.next = head;
    head = node;
  }
  let sum: u32 = 0;
  for (let cur = head; cur !== null; cur = cur.next) sum += cur.val;
  return sum;
}

export function staleInListWalk(): u32 {
  const a = nodes.add(new Node(1))!;
  const b = nodes.add(new Node(2))!;
  a.next = b;
  nodes.remove(b);
  let sum: u32 = 0;
  for (let cur: Node | null = a; cur !== null; cur = cur.next) sum += cur.val;
  return sum;
}

export function coalesce(useFirst: bool): u32 {
  const a = nodes.add(new Node(5))!;
  const pick: Node | null = useFirst ? a : null;
  return (pick ?? zero).val;
}

export function nullBang(): u32 {
  const none: Node | null = lastNode(0);
  return none!.val;
}

function lastNode(n: u32): Node | null {
  return n === 0 ? null : nodes.add(new Node(n));
}

export function optionalCall(): u32 {
  const n = nodes.add(new Node(1))!;
  const none = lastNode(0);
  none?.setVal(5);
  n?.setVal(6);
  return n.val;
}

class Ops {
  constructor(private op: (a: u32, b: u32) => u32) {}
  run(a: u32, b: u32): u32 {
    return this.op(a, b);
  }
}
function add(a: u32, b: u32): u32 {
  return a + b;
}
function mul(a: u32, b: u32): u32 {
  return a * b;
}
const addOps = new Ops(add);
const TABLE: readonly ((a: u32, b: u32) => u32)[] = [add, mul];

export function functionFields(a: u32, b: u32): u32 {
  const m = new Ops(mul);
  return addOps.run(a, b) * 100 + m.run(a, b);
}

export function dispatchTable(i: usize, a: u32, b: u32): u32 {
  return TABLE[i]!(a, b);
}

class Box<T> {
  constructor(public v: T) {}
  get value(): T {
    return this.v;
  }
  map(f: (x: T) => T): Box<T> {
    return this.with(f(this.v));
  }
  with(x: T): Box<T> {
    this.v = x;
    return this;
  }
}

function identity<T>(x: T): T {
  return x;
}

export function genericClass(x: u32): u32 {
  const b = new Box<u32>(x);
  const big = new Box<u64>(5n);
  const n = nodes.add(new Node(3))!;
  const r = new Box<Node>(n);
  return b.map((y) => y + 1).value + toU32(big.value) + r.value.val + identity<u32>(100);
}

export type Mode = "fast" | "slow";
class Modes {
  mode: Mode = "slow";
  small: u8 = 200;
  neg: i8 = -5;
  flag: bool = true;
  f: f64 = 1.5;
}

export function narrowFields(): u32 {
  const m = new Modes();
  m.small = 250;
  m.mode = "fast";
  m.flag = !m.flag;
  const fast = m.mode === "fast" ? 1000 : 0;
  return fast + m.small + (m.flag ? 1 : 0) + (m.neg === -5 ? 2 : 0) + (m.f === 1.5 ? 4 : 0);
}

let lastSeen: Node | null = null;
let count: u32 = 0;

export function globals(n: u32): u32 {
  count += n;
  lastSeen = nodes.add(new Node(count));
  return lastSeen!.val;
}

export function staleGlobal(): u32 {
  const n = lastSeen!;
  nodes.remove(n);
  return lastSeen!.val;
}

function tryGet(n: u32): Result<Node, "none"> {
  const x = lastNode(n);
  if (x === null) return { ok: false, error: "none" };
  return { ok: true, value: x };
}

export function unionHoldsReference(n: u32): u32 {
  const r = tryGet(n);
  return r.ok ? r.value.val : 1000;
}

export class Flags {
  a = u32f();
  b = u32f();
  total(): u32 {
    return this.a + this.b;
  }
}

export function makeInLoop(n: usize): u32 {
  let sum: u32 = 0;
  for (let i = 0; i < n; i++) {
    const f = make(Flags, { a: 1, b: 2 });
    sum += f.total();
  }
  return sum;
}

export function arithmeticOnFields(): u32 {
  const b = new Box<u32>(10);
  b.v += 5;
  b.v *= 2;
  b.v -= 1;
  b.v %= 7;
  b.v = (b.v << 2) >>> 0;
  return b.v;
}

export function vecOfStaticHeap(n: usize): usize {
  using v = new Vec(u32f, heap);
  for (let i = 0; i < n; i++) v.push(toU32(i));
  return v.length;
}

export function overflowInField(): u8 {
  const m = new Modes();
  m.small = m.small + 100 > 255 ? 255 : 0;
  m.small += 1;
  return m.small;
}
