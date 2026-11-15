// TSL proper in a `leak` package (SPEC 3.5): an escaping new is legal, needs no unsafe, and never goes stale.
import { type u32 } from "@tsl/core";

export class Node {
  next: Node | null = null;
  constructor(public value: u32) {}
}

let head: Node | null = null;

function cons(v: u32, tail: Node | null): Node {
  const n = new Node(v);
  n.next = tail;
  return n; // TSL3002 in strict
}

export function push(v: u32): u32 {
  head = cons(v, head); // TSL3001 in strict
  return v;
}

export function sum(): u32 {
  let t: u32 = 0;
  for (let c = head; c !== null; c = c.next) t = (t + c.value) >>> 0;
  return t;
}

export function build(n: u32): u32 {
  // A new in a loop that flows out of it is a heap object here, where strict says TSL3007.
  let first: Node | null = null;
  for (let i: u32 = 0; i < n; i++) {
    const c = new Node(i);
    c.next = first;
    first = c;
  }
  let k: u32 = 0;
  for (let c = first; c !== null; c = c.next) k++;
  return k;
}

/** Doesn't escape, so it's a stack object: no page is touched, and a limit of zero pages wouldn't stop it. */
export function onStack(v: u32): u32 {
  const n = new Node(v);
  return n.value + 1;
}

export function cycle(a: u32, b: u32): u32 {
  const x = new Node(a);
  const y = new Node(b);
  x.next = y;
  y.next = x;
  head = x;
  return x.next.next!.value;
}
