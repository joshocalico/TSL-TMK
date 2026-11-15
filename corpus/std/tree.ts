// A tree with no arena and no parent pointers: each node has a Vec of children, and nodes live in a Slab (SPEC 3.5).
import { toU32, u32, type usize } from "@tsl/core";
import { ref, Slab, Vec } from "@tsl/std";

class Node {
  kids = new Vec(ref<Node>());
  constructor(public value: u32) {}
}

const nodes = new Slab<Node>();

function build(depth: u32, width: u32, next: Counter): Node {
  const n = nodes.add(new Node(next.take()));
  if (depth > 0) {
    for (let i: u32 = 0; i < width; i++) n.kids.push(build(depth - 1, width, next));
  }
  return n;
}

class Counter {
  v: u32 = 0;
  take(): u32 {
    this.v++;
    return this.v;
  }
}

function sum(n: Node): u32 {
  let s: u32 = n.value;
  n.kids.forEach((k) => {
    s = (s + sum(k)) >>> 0;
  });
  return s;
}

function depthOf(n: Node): u32 {
  let d: u32 = 0;
  for (let i: usize = 0; i < n.kids.length; i++) {
    const below = depthOf(n.kids.get(i)) + 1;
    if (below > d) d = below;
  }
  return d;
}

function destroy(n: Node): void {
  while (n.kids.length > 0) destroy(n.kids.pop());
  n.kids.free();
  nodes.remove(n);
}

function count(n: Node): u32 {
  let c: u32 = 1;
  n.kids.forEach((k) => {
    c += count(k);
  });
  return c;
}

export function builtAndSummed(depth: u32, width: u32): u32 {
  const before = toU32(nodes.size);
  const c = new Counter();
  const root = build(depth, width, c);
  const s = sum(root);
  const here = count(root);
  destroy(root);
  return (s + here + depthOf(nodes.add(new Node(0))) + toU32(nodes.size) - before) >>> 0;
}

export function freedComesBack(rounds: u32): u32 {
  let last: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const c = new Counter();
    const root = build(3, 3, c);
    last = sum(root);
    destroy(root);
  }
  return last;
}

/** A child removed from the tree is still safe to hold: a reference to it traps 5 once it's gone. */
export function aStaleChild(): u32 {
  const c = new Counter();
  const root = build(1, 2, c);
  const kid = root.kids.get(0);
  destroy(kid);
  return root.kids.get(0).value;
}

export function aStaleChildInForEach(): u32 {
  const c = new Counter();
  const root = build(1, 2, c);
  destroy(root.kids.get(1));
  let seen: u32 = 0;
  root.kids.forEach(() => {
    seen++;
  });
  return seen;
}

export function reparented(): u32 {
  const c = new Counter();
  const a = build(1, 2, c);
  const b = build(1, 2, c);
  b.kids.push(a.kids.swapRemove(0));
  const r = sum(a) * 1000 + sum(b);
  destroy(a);
  destroy(b);
  return r;
}
