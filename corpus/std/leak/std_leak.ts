// memory-pages: 256
// @tsl/std in a `leak` package (SPEC 3.5, D43): an escaping `new Vec` is a leak object, so it can be returned and stored, and
// its buffer still comes from the global allocator and goes back. Both are out of memory at trap 14.
import { lit, toU32, u32, type usize } from "@tsl/core";
import { ExactMap, ref, Set, Slab, Str, StrBuilder, Vec } from "@tsl/std";

function range(n: u32): Vec<u32> {
  const v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  return v; // TSL3002 in strict
}

export function returned(n: u32): u32 {
  const v = range(n);
  const out = v.get(n - 1) + toU32(v.length);
  v.free();
  return out;
}

class Node {
  kids: Vec<Node> = new Vec(ref<Node>());
  constructor(public value: u32) {}
}

function tree(d: u32): Node {
  const n = new Node(d);
  for (let i: u32 = 0; i < d; i++) n.kids.push(tree(d - 1));
  return n;
}

function sum(n: Node): u32 {
  let s: u32 = n.value;
  n.kids.forEach((k) => {
    s += sum(k);
  });
  return s;
}

export function aTreeOfLeakObjects(d: u32): u32 {
  return sum(tree(d));
}

let kept: Vec<u32> | null = null;

export function keptInAGlobal(x: u32): u32 {
  if (kept === null) kept = new Vec(u32);
  kept.push(x);
  return toU32(kept.length);
}

const index = new ExactMap(u32, ref<Node>());

export function leakObjectsInAMap(k: u32): u32 {
  index.set(k, new Node(k));
  return index.get(k).value;
}

class Thing {
  constructor(public v: u32) {}
}
const things = new Slab<Thing>();

// A Slab's object stays checked in a leak package's Vec, and a leak object stays live.
export function slabStaysChecked(): u32 {
  using v = new Vec(ref<Thing>());
  const t = things.add(new Thing(1));
  v.push(t);
  things.remove(t);
  return v.get(0).v;
}

export function leakObjectIsAlwaysLive(): u32 {
  using v = new Vec(ref<Node>());
  v.push(new Node(9));
  let s: u32 = 0;
  v.forEach((n) => {
    s += n.value;
  });
  return s;
}

export function loansStillTrap(): u32 {
  const v = range(3);
  v.forEach(() => {
    v.push(1);
  });
  return 0;
}

export function strsAndBuilders(): usize {
  const s = new StrBuilder();
  s.append(Str.of(lit("left ")));
  s.append(Str.of(lit("right")));
  const out = s.finish();
  s.free();
  return out.length;
}

export function setOfObjects(): u32 {
  using s = new Set(ref<Node>());
  const a = new Node(1);
  const b = new Node(2);
  s.add(a);
  s.add(b);
  s.add(a);
  return toU32(s.size);
}

export function vecBuffersComeBack(rounds: u32): u32 {
  let last: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    const v = range(1000);
    last = v.get(999);
    v.free();
  }
  return last;
}

export function memoryRunsOut(n: u32): u32 {
  const v = new Vec(u32);
  for (let i: u32 = 0; i < n; i++) v.push(i);
  return toU32(v.length);
}
