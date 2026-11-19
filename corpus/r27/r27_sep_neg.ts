// R27 (SPEC 3.5, D77): where fresh-allocation separation must NOT apply, and what each injected bug would get wrong. Each
// class here keeps words in a block, as r27_sep.ts's Buf does, but its block is reachable some other way, or a call in the
// loop writes its length, so tslc doesn't separate its field, or the optimiser doesn't keep the length: every answer and
// trap is V8's, at every level, and the build is the same with the separation on or off (tools/r27-tests.ts checks that).
// Under R27's bugs (tools/r27-tests.ts's R27_FAULTS) these give wrong answers, or miss a trap.
import { Heap } from "@tsl/alloc";
import { toU32, trap, Trap, u32, u64, type usize } from "@tsl/core";
import { bytesAt, copyBytes, ptrAt, viewAt } from "@tsl/unsafe";
import { pages } from "../mem/pages.ts";

const heap = new Heap(pages);

/** Two words at the start of a block, viewed in place. */
export class Hdr {
  n = u32();
  m = u32();
}

/** Its block's address escapes before it's filled: `where` gives it to code outside the class. */
// SAFETY: a block of cap words from the heap, fresh when made, given back with its size, and read and written only below
// len, which is at most cap.
export class Escapes {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  get length(): usize {
    return this.len;
  }

  get(i: usize): u32 {
    if (i >= this.len) trap(Trap.Bounds);
    return ptrAt(u32, this.data).add(i).read();
  }

  set(i: usize, v: u32): void {
    if (i >= this.len) trap(Trap.Bounds);
    ptrAt(u32, this.data).add(i).write(v);
  }

  /** The block's address, for anyone. */
  where(): u64 {
    return this.data;
  }

  /** @tsl.noinline */
  reset(n: usize, k: u32): void {
    if (this.cap < n) {
      const b = heap.allocBytes(n * 4);
      if (b === 0n) trap(Trap.OutOfMemory);
      if (this.cap !== 0) heap.freeBytes(this.data, this.cap * 4);
      this.data = b;
      this.cap = n;
    }
    this.len = n;
    for (let i: usize = 0; i < n; i++) this.set(i, ((Math.imul(toU32(i), k) >>> 0) + 1) >>> 0);
  }
}

/** A plain holder of an address: what Kept stores its block's address in. */
export class Holder {
  at: u64 = 0n;
}

/** Its block's address is stored in another object's field, and read back from there. */
// SAFETY: a block of cap words from the heap, fresh when made, given back with its size, and read and written only below
// len, which is at most cap.
export class Kept {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  get(i: usize): u32 {
    if (i >= this.len) trap(Trap.Bounds);
    return ptrAt(u32, this.data).add(i).read();
  }

  set(i: usize, v: u32): void {
    if (i >= this.len) trap(Trap.Bounds);
    ptrAt(u32, this.data).add(i).write(v);
  }

  keepIn(h: Holder): void {
    h.at = this.data;
  }

  /** @tsl.noinline */
  reset(n: usize): void {
    if (this.cap < n) {
      const b = heap.allocBytes(n * 4);
      if (b === 0n) trap(Trap.OutOfMemory);
      bytesAt(b, n * 4).fill(0);
      if (this.cap !== 0) {
        copyBytes(b, this.data, this.cap * 4);
        heap.freeBytes(this.data, this.cap * 4);
      }
      this.data = b;
      this.cap = n;
    }
    this.len = n;
  }
}

/** Separated (its block reaches nothing else), but a call in the loop writes its length. */
// SAFETY: a block of cap words from the heap, fresh when made, given back with its size, and read and written only below
// len, which is at most cap.
export class Arr {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  get length(): usize {
    return this.len;
  }

  get(i: usize): u32 {
    if (i >= this.len) trap(Trap.Bounds);
    return ptrAt(u32, this.data).add(i).read();
  }

  set(i: usize, v: u32): void {
    if (i >= this.len) trap(Trap.Bounds);
    ptrAt(u32, this.data).add(i).write(v);
  }

  cut(n: usize): void {
    if (n < this.len) this.len = n;
  }

  /** @tsl.noinline */
  reset(n: usize, k: u32): void {
    if (this.cap < n) {
      const b = heap.allocBytes(n * 4);
      if (b === 0n) trap(Trap.OutOfMemory);
      if (this.cap !== 0) heap.freeBytes(this.data, this.cap * 4);
      this.data = b;
      this.cap = n;
    }
    this.len = n;
    for (let i: usize = 0; i < n; i++) this.set(i, ((Math.imul(toU32(i), k) >>> 0) + 1) >>> 0);
  }
}

/** A word that holds an address someone set, not a block of its own: what a raw store goes through. */
export class Ref {
  at: u64 = 0n;
  point(a: u64): void {
    this.at = a;
  }
}

const E = new Escapes();
const K = new Kept();
const H = new Holder();
const S = new Arr();
const R = new Ref();

/** A view of the escaped block's first word: its store is the block's, so the element read after sees it. */
// SAFETY: E's block holds 4 words, so a Hdr at its start is in it.
export function escapeView(): u32 {
  E.reset(4, 1);
  const h = viewAt(Hdr, E.where());
  const a: u32 = E.get(0);
  h.n = 40;
  const b: u32 = E.get(0);
  return ((Math.imul(a, 1000) >>> 0) + b) >>> 0;
}

/** A bound kept in the escaped block's second word, which a store into the block changes: k past it traps 2. */
// SAFETY: E's block holds 8 words, so a Hdr at its start is in it.
export function escapeBound(k: usize): u32 {
  E.reset(8, 0);
  const h = viewAt(Hdr, E.where());
  h.m = 6;
  E.set(1, 2);
  if (toU32(k) >= h.m) trap(Trap.Bounds);
  return h.m;
}

/** The block's address stored in Holder's field, read back and viewed: the view's store is the block's. */
// SAFETY: K's block holds 4 words, so a Hdr at its start is in it.
export function storedAndReadBack(): u32 {
  K.reset(4);
  K.keepIn(H);
  const v = viewAt(Hdr, H.at);
  K.set(0, 5);
  v.n = 77;
  return K.get(0);
}

/** Cuts S's length, out of line. */
/** @tsl.noinline */
function shorten(n: usize): void {
  S.cut(n);
}

/** A call in the fill loop writes the length: get's check is read again after it, and traps 2 where i reaches the cut. */
export function callWrites(n: usize, at: usize): u32 {
  S.reset(n, 3);
  const m = S.length;
  let s: u32 = 0;
  for (let i: usize = 0; i < m; i++) {
    if (i === at) shorten(at);
    s = (s + S.get(i)) >>> 0;
  }
  return s;
}

/** A raw store through an address read from a field (Ref's, not a block's): it changes the view's word read after. */
// SAFETY: a block of 16 bytes we own until it goes back: the Hdr and the raw store are in it.
export function rawThroughField(): u32 {
  const blk = heap.allocBytes(16);
  if (blk === 0n) trap(Trap.OutOfMemory);
  bytesAt(blk, 16).fill(0);
  const h = viewAt(Hdr, blk);
  R.point(blk);
  h.n = 3;
  const a: u32 = h.n;
  ptrAt(u32, R.at).write(9);
  const b: u32 = h.n;
  heap.freeBytes(blk, 16);
  return a * 10 + b;
}
