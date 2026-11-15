// Prototype (design/api-audit.md A5, option c): a page source is an object with a method, and Heap holds it
// in an interface-typed field. A scratch copy of @tsl/alloc's Heap; only the source changes.
import { idiv, toU64, u64, type bool, type usize } from "@tsl/core";
import { ptrAt, type Ptr } from "@tsl/unsafe";

export const PAGE: usize = 4096;
const CLASSES: usize = 8;

/** Hands out zeroed runs of pages, or 0n when there are none. */
export interface PageSource {
  pages(n: usize): u64;
}

function classOf(bytes: usize): usize {
  let size: usize = 16;
  for (let c = 0; c < CLASSES; c++) {
    if (bytes <= size) return c;
    size = size * 2;
  }
  return CLASSES;
}

export class Heap {
  private heads: u64 = 0n;
  private bump: u64 = 0n;
  private bumpEnd: u64 = 0n;

  constructor(private source: PageSource) {}

  // SAFETY: heads is a whole page from setUp, and c is below CLASSES.
  private head(c: usize): Ptr<u64> {
    return ptrAt(u64, this.heads + toU64(c * 8));
  }

  private setUp(): bool {
    const first = this.source.pages(1);
    if (first === 0n) return false;
    this.heads = first;
    this.bump = first + 64n;
    this.bumpEnd = first + toU64(PAGE);
    return true;
  }

  // SAFETY: a free block's first word is its link, and every block is at least 16 bytes, from pages we were given.
  allocBytes(bytes: usize): u64 {
    if (this.heads === 0n && !this.setUp()) return 0n;
    const c = classOf(bytes);
    if (c === CLASSES) return this.source.pages(idiv(bytes + PAGE - 1, PAGE));
    const head = this.head(c);
    const block = head.read();
    if (block !== 0n) {
      head.write(ptrAt(u64, block).read());
      return block;
    }
    const size = 16n << toU64(c);
    const at = ((this.bump + size - 1n) / size) * size;
    if (at + size > this.bumpEnd) {
      const page = this.source.pages(1);
      if (page === 0n) return 0n;
      this.bump = page + size;
      this.bumpEnd = page + toU64(PAGE);
      return page;
    }
    this.bump = at + size;
    return at;
  }

  // SAFETY: the caller gives back a block it got from allocBytes with this size.
  freeBytes(addr: u64, bytes: usize): void {
    const c = classOf(bytes);
    if (c === CLASSES) return;
    const head = this.head(c);
    ptrAt(u64, addr).write(head.read());
    head.write(addr);
  }
}
