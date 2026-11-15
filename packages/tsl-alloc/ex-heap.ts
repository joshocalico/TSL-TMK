// file: ex-heap.ts
import { idiv, toU64, u64, type bool, type usize } from "@tsl/core";
import { copyBytes, elemSize, pageRunFreed, ptrAt, type ElemOf, type Ptr } from "@tsl/unsafe";

export const PAGE: usize = 4096;
const CLASSES: usize = 8; // 16, 32, ... 2048 bytes; anything larger takes whole pages

/** Hands out zeroed runs of pages, or 0n when there are none. This is the only part that differs per environment. */
export type PageSource = (pages: usize) => u64;

function classOf(bytes: usize): usize {
  let size: usize = 16;
  for (let c = 0; c < CLASSES; c++) {
    if (bytes <= size) return c;
    size = size * 2;
  }
  return CLASSES;
}

/** A size-class allocator. Callers pass the size back on free, so blocks carry no headers. */
export class Heap {
  private heads: u64 = 0n; // CLASSES free-list heads, at the start of the first page
  private bump: u64 = 0n;
  private bumpEnd: u64 = 0n;

  constructor(private source: PageSource) {}

  // SAFETY: heads is a whole page from setUp, and c is below CLASSES, so this is within the 64 bytes reserved there.
  private head(c: usize): Ptr<u64> {
    return ptrAt(u64, this.heads + toU64(c * 8));
  }

  private setUp(): bool {
    const first = this.source(1);
    if (first === 0n) return false;
    this.heads = first;
    this.bump = first + 64n;
    this.bumpEnd = first + toU64(PAGE);
    return true;
  }

  /** Returns an address aligned to the block size, or 0n when out of memory. */
  // SAFETY: a free block's first word is its link, and every block is at least 16 bytes, from pages we were given.
  allocBytes(bytes: usize): u64 {
    if (this.heads === 0n && !this.setUp()) return 0n;
    const c = classOf(bytes);
    if (c === CLASSES) return this.source(idiv(bytes + PAGE - 1, PAGE));
    const head = this.head(c);
    const block = head.read();
    if (block !== 0n) {
      head.write(ptrAt(u64, block).read());
      return block;
    }
    const size = 16n << toU64(c);
    const at = ((this.bump + size - 1n) / size) * size;
    if (at + size > this.bumpEnd) {
      const page = this.source(1);
      if (page === 0n) return 0n;
      this.bump = page + size;
      this.bumpEnd = page + toU64(PAGE);
      return page;
    }
    this.bump = at + size;
    return at;
  }

  // SAFETY: the caller gives back a block it got from allocBytes with this size, so the link fits and nothing else has it.
  freeBytes(addr: u64, bytes: usize): void {
    const c = classOf(bytes);
    if (c === CLASSES) return pageRunFreed(addr, idiv(bytes + PAGE - 1, PAGE)); // @tsl/std takes these, and with no std they stay with the domain
    const head = this.head(c);
    ptrAt(u64, addr).write(head.read());
    head.write(addr);
  }
}

// SAFETY: the address is a fresh block of n elements, or null when there isn't one.
export function alloc<T>(heap: Heap, e: ElemOf<T>, n: usize): Ptr<T> | null {
  const a = heap.allocBytes(n * elemSize(e));
  return a === 0n ? null : ptrAt(e, a);
}

export function free<T>(heap: Heap, e: ElemOf<T>, p: Ptr<T>, n: usize): void {
  heap.freeBytes(p.addr, n * elemSize(e));
}

// SAFETY: the caller owns n elements at both pointers.
export function copyElems<T>(e: ElemOf<T>, dst: Ptr<T>, src: Ptr<T>, n: usize): void {
  copyBytes(dst.addr, src.addr, n * elemSize(e));
}
