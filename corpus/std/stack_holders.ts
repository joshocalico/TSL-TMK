// A stack object holding a stack object of the same frame, or one it was given: an ordinary helper over a local Vec (SPEC 3.5).
import { Heap, Vec as AllocVec } from "@tsl/alloc";
import { toU32, toU64, u32, type bool, type u64, type usize } from "@tsl/core";
import { ref, Slab, Vec } from "@tsl/std";

class Writer {
  written: u32 = 0;
  constructor(private out: Vec<u32>) {}
  put(x: u32): void {
    this.out.push(x);
    this.written++;
  }
}

export function aHelperOverALocal(n: u32): u32 {
  using v = new Vec(u32);
  const w = new Writer(v);
  for (let i: u32 = 0; i < n; i++) w.put(i);
  return w.written + toU32(v.length);
}

export function givenByTheCaller(n: u32): u32 {
  using v = new Vec(u32);
  fill(v, n);
  return toU32(v.length);
}

function fill(v: Vec<u32>, n: u32): void {
  const w = new Writer(v);
  for (let i: u32 = 0; i < n; i++) w.put(i);
}

class Pair {
  a: Writer | null = null;
  b: Writer | null = null;
}

export function assignedByHand(): u32 {
  using v = new Vec(u32);
  const w = new Writer(v);
  const p = new Pair();
  p.a = w;
  p.b = w;
  p.a.put(1);
  p.b.put(2);
  return w.written;
}

class Late {
  out: Vec<u32> | null = null;
  attach(v: Vec<u32>): void {
    this.out = v;
  }
  put(x: u32): void {
    this.out!.push(x);
  }
}

export function attachedLater(): u32 {
  using v = new Vec(u32);
  const l = new Late();
  l.attach(v);
  l.put(7);
  return v.get(0);
}

// What the first of the known limits was: a local Heap, and a local Vec over it.
const POOL = new Uint8Array(1);
let served: usize = 0;
function noPages(n: usize): u64 {
  served += n;
  return toU64(POOL.length) * 0n;
}

export function aLocalHeapAndALocalVec(): bool {
  const h = new Heap(noPages);
  using v = new AllocVec(u32, h);
  return v.push(1); // no pages to be had: false, and the Vec is fine
}

// A view of a field held in place, held by a stack object, is as good as a local holding it.
class Node {
  kids = new Vec(u32);
}
const nodes = new Slab<Node>();
export function aViewHeld(): u32 {
  const n = nodes.add(new Node());
  const w = new Writer(n.kids);
  w.put(3);
  return n.kids.get(0);
}

class Team {
  members = new Vec(ref<Node>());
}

export function aHolderCanAlsoHoldReferences(): usize {
  const t = new Team();
  t.members.push(nodes.add(new Node()));
  const n = t.members.length;
  t.members.free();
  return n;
}
