// R27 (SPEC 3.5, D77): fresh-allocation separation where it applies. `Buf` keeps its words in a block of its own, which only
// its methods reach: tslc proves its `data` field separated (compiler/host/separate.ts), so a store into the block changes
// no object's field, and the optimiser keeps a length it read across such a store, or across a call that writes only
// blocks, and a bounds check the loop's own test already made goes. Every answer and trap is V8's, at every level: a
// length a store or a call does change is read again, and a check a loop's test doesn't make stays.
import { Heap } from "@tsl/alloc";
import { toU32, trap, Trap, u32, u64, type usize } from "@tsl/core";
import { bytesAt, copyBytes, ptrAt } from "@tsl/unsafe";
import { pages } from "../mem/pages.ts";

const heap = new Heap(pages);

/** Words in a block of their own: `data` is separated (D77). Made empty; `grow` and `reset` make its blocks. */
export class Buf {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  get length(): usize {
    return this.len;
  }

  // SAFETY: i is below len, which is at most cap, so the word is in the block.
  get(i: usize): u32 {
    if (i >= this.len) trap(Trap.Bounds);
    return ptrAt(u32, this.data).add(i).read();
  }

  // SAFETY: as get.
  set(i: usize, v: u32): void {
    if (i >= this.len) trap(Trap.Bounds);
    ptrAt(u32, this.data).add(i).write(v);
  }

  /** Shorter: what's dropped stays in the block, past the length. */
  cut(n: usize): void {
    if (n < this.len) this.len = n;
  }

  // SAFETY: a fresh block, zeroed, the old words copied in, and the old block given back with its size: nothing keeps it.
  grow(n: usize): void {
    if (n <= this.cap) {
      if (n > this.len) this.len = n;
      return;
    }
    const b = heap.allocBytes(n * 4);
    if (b === 0n) trap(Trap.OutOfMemory);
    bytesAt(b, n * 4).fill(0);
    copyBytes(b, this.data, this.len * 4);
    heap.freeBytes(this.data, this.cap * 4);
    this.data = b;
    this.cap = n;
    this.len = n;
  }

  /** Takes o's block, giving its own back, and leaves o empty, as JsArray's adopt. */
  // SAFETY: this block goes back once, o's moves here, and o keeps none.
  adopt(o: Buf): void {
    heap.freeBytes(this.data, this.cap * 4);
    this.data = o.data;
    this.len = o.len;
    this.cap = o.cap;
    o.data = 0n;
    o.len = 0;
    o.cap = 0;
  }

  // SAFETY: the block goes back once, and with the length 0 nothing reads it after.
  free(): void {
    if (this.cap !== 0) heap.freeBytes(this.data, this.cap * 4);
    this.data = 0n;
    this.len = 0;
    this.cap = 0;
  }

  /** Empty, then n words of i * k + 1. */
  reset(n: usize, k: u32): void {
    this.cut(0);
    this.grow(n);
    for (let i: usize = 0; i < n; i++) this.set(i, ((Math.imul(toU32(i), k) >>> 0) + 1) >>> 0);
  }
}

// Module-level arrays: their fields are memory the optimiser must reason about (a function's own arrays are taken apart
// into values, and then there are no fields to keep).
const A = new Buf();
const B = new Buf();
const C = new Buf();

/** One block filled from another: the store into B's block keeps A's length, so A.get's check is the loop test's. */
export function copyAll(n: usize): u32 {
  A.reset(n, 3);
  B.reset(n, 0);
  for (let i: usize = 0; i < A.length; i++) B.set(i, A.get(i) + 1);
  let s: u32 = 0;
  for (let i: usize = 0; i < B.length; i++) s = (s + B.get(i)) >>> 0;
  return s;
}

/** The same, with A's length cut partway: the cut is a store of the length, read again, and A.get traps 2 (V8 too). */
export function copyCut(n: usize, at: usize): u32 {
  A.reset(n, 3);
  B.reset(n, 0);
  const m = A.length;
  for (let i: usize = 0; i < m; i++) {
    if (i === at) A.cut(at);
    B.set(i, A.get(i));
  }
  return B.get(n - 1);
}

/** Stored into through a function that writes only blocks: the call keeps A's length. */
/** @tsl.noinline */
function put(i: usize, v: u32): void {
  B.set(i, v);
}

export function fillThroughCall(n: usize): u32 {
  A.reset(n, 5);
  B.reset(n, 0);
  for (let i: usize = 0; i < A.length; i++) put(i, (A.get(i) ^ 0x55) >>> 0);
  let s: u32 = 0;
  for (let i: usize = 0; i < n; i++) s = (s + (Math.imul(B.get(i), toU32(i + 1)) >>> 0)) >>> 0;
  return s;
}

/** A block grown as it's filled: growth makes a new block, so its length and block are read again after each. */
export function growAsFilled(n: usize): u32 {
  B.free();
  for (let i: usize = 0; i < n; i++) {
    if (i >= B.length) B.grow(i * 2 + 1);
    B.set(i, toU32(i) + 7);
  }
  let s: u32 = 0;
  for (let i: usize = 0; i < B.length; i++) s = (s + B.get(i)) >>> 0;
  return (s + (Math.imul(toU32(B.length), 1000) >>> 0)) >>> 0;
}

/** Blocks moved between arrays partway through a fill: what's read after is the block moved in, and C is left empty. */
export function adoptMidFill(n: usize): u32 {
  A.reset(n, 2);
  B.reset(n, 0);
  C.reset(n, 9);
  let s: u32 = 0;
  for (let i: usize = 0; i < n; i++) {
    if (i * 2 === n) A.adopt(C);
    B.set(i, A.get(i));
    s = (s + B.get(i)) >>> 0;
  }
  return (s + toU32(C.length)) >>> 0;
}

/** A loop one past the end: no test makes get's check, which traps 2 on the last turn. */
export function readPast(n: usize): u32 {
  A.reset(n, 1);
  B.reset(n + 1, 0);
  let s: u32 = 0;
  for (let i: usize = 0; i <= n; i++) {
    B.set(i, A.get(i));
    s = (s + B.get(i)) >>> 0;
  }
  return s;
}
