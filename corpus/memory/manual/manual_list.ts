// TSL proper in a `manual` package (SPEC 3.5): escaping objects from the heap, plain pointers, no checks.
import { type u32 } from "@tsl/core";

export class Node {
  next: Node | null = null;
  left: Node | null = null;
  constructor(public value: u32) {}
}

let head: Node | null = null;

export function push(v: u32): u32 {
  const n = new Node(v);
  n.next = head;
  head = n;
  return v;
}

export function sum(): u32 {
  let t: u32 = 0;
  for (let c = head; c !== null; c = c.next) t = (t + c.value) >>> 0;
  return t;
}

function insert(t: Node | null, v: u32): Node {
  if (t === null) return new Node(v);
  if (v < t.value) t.left = insert(t.left, v);
  else t.next = insert(t.next, v);
  return t;
}

function total(t: Node | null): u32 {
  return t === null ? 0 : t.value + total(t.left) + total(t.next);
}

export function tree(n: u32): u32 {
  let root: Node | null = null;
  let x: u32 = 17;
  for (let i: u32 = 0; i < n; i++) {
    x = ((Math.imul(x, 31) + 7) >>> 0) % 1000;
    root = insert(root, x);
  }
  return total(root);
}

/** Doesn't escape, so it's still a stack object. */
export function onStack(v: u32): u32 {
  const s = new Node(v);
  return s.value * 2;
}
