// Block reuse and raw pointers, from an unsafe module (SPEC 3.5).
import { Heap, alloc, copyElems, free } from "@tsl/alloc";
import {
  toU32,
  toU64,
  u16 as u16f,
  u32,
  u32 as u32f,
  u64,
  u8,
  type bool,
  type usize,
} from "@tsl/core";
import {
  addrOf,
  bytesAt,
  copyBytes,
  elemSize,
  inlineOf,
  ptrAt,
  sliceOf,
  viewAt,
} from "@tsl/unsafe";
import { limitPages, pages, pagesUsed } from "./pages.ts";

const heap = new Heap(pages);

// SAFETY: the block is ours until free.
export function ptrReadWrite(): u32 {
  const p = alloc(heap, u32, 16)!;
  p.add(3).write(7);
  p.add(4).write(9);
  const r = p.add(3).read() + p.add(4).read() * 10;
  free(heap, u32, p, 16);
  return r;
}

// SAFETY: the block is ours until free, and only its address is kept after that.
export function freedBlockReused(): bool {
  const p = alloc(heap, u32, 16)!;
  const a = p.addr;
  free(heap, u32, p, 16);
  const q = alloc(heap, u32, 16)!;
  const same = q.addr === a;
  free(heap, u32, q, 16);
  return same;
}

// SAFETY: only addresses are compared.
export function blockAligned(): bool {
  for (let n: usize = 1; n <= 2048; n = n * 2) {
    const a = heap.allocBytes(n);
    const size = n < 16 ? 16n : toU64(n);
    if (a % size !== 0n) return false;
    heap.freeBytes(a, n);
  }
  return true;
}

export function classesDontMix(): bool {
  const a = heap.allocBytes(16);
  const b = heap.allocBytes(32);
  const c = heap.allocBytes(16);
  const ok = a !== b && b !== c && a !== c;
  heap.freeBytes(a, 16);
  heap.freeBytes(b, 32);
  heap.freeBytes(c, 16);
  return ok;
}

export function largeRun(): bool {
  return heap.allocBytes(20000) !== 0n;
}

// SAFETY: both blocks are ours, and big enough.
export function copies(): u32 {
  const p = alloc(heap, u8, 32)!;
  const q = alloc(heap, u8, 32)!;
  for (let i = 0; i < 32; i++) p.add(i).write(wrap(i));
  copyElems(u8, q, p, 32);
  copyBytes(q.addr + 16n, q.addr, 8);
  let sum: u32 = 0;
  for (let i = 0; i < 32; i++) sum += q.add(i).read();
  free(heap, u8, p, 32);
  free(heap, u8, q, 32);
  return sum;
}

function wrap(i: usize): u8 {
  return i < 255 ? toU8i(i) : 255;
}
function toU8i(i: usize): u8 {
  return toU32i(i) & 0xff;
}
function toU32i(i: usize): u32 {
  return i < 100000 ? toU32(i) : 0;
}

export function elemSizes(): usize {
  return elemSize(u8) + elemSize(u32) * 10 + elemSize(u64) * 100;
}

// SAFETY: a pointer cast only changes how the same block is read.
export function casts(): u64 {
  const p = alloc(heap, u64, 1)!;
  p.write(0x0102030405060708n);
  const low = p.cast(u32).read();
  free(heap, u64, p, 1);
  return toU64(low);
}

// SAFETY: an address near zero, which faults natively and is unmapped on the host.
export function nullDeref(): u32 {
  return ptrAt(u32, 8n).read();
}

export class Wire {
  x = u32f();
  y = u16f();
  z = u16f();
}

// SAFETY: a block we own, and big enough for a Wire.
export function viewsAndSlices(): u32 {
  const a = heap.allocBytes(64);
  const w = viewAt(Wire, a);
  w.x = 0x04030201;
  w.y = 7;
  const b = bytesAt(a, 8);
  const words = sliceOf(u32f, a, 2);
  const out = b[1]! + words[0]! - 0x04030201 + w.y + (addrOf(w) === a ? 1000 : 0);
  heap.freeBytes(a, 64);
  return out;
}

class Inline {
  constructor(
    public a: u64,
    public b: u32,
  ) {}
}

// SAFETY: a block we own. An inline Ptr strides over whole objects, and its write moves one into place.
export function inlineElements(): u64 {
  const e = inlineOf<Inline>();
  const a = heap.allocBytes(elemSize(e) * 4);
  const p = ptrAt(e, a);
  p.add(2).write(new Inline(9n, 1));
  const v = p.add(2).read().a;
  heap.freeBytes(a, elemSize(e) * 4);
  return v;
}

export function outOfMemoryIsANormalResult(): bool {
  limitPages(0);
  const starving = new Stack();
  return starving.ok();
}

class Stack {
  ok(): bool {
    return pagesUsed() >= 0 && pages(1) === 0n;
  }
}
