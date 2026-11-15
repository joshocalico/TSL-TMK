// file: ex-vec.ts
import { Trap, trap, type ArrayOf, type bool, type usize } from "@tsl/core";
import { sliceOf, type ElemOf, type Ptr } from "@tsl/unsafe";
import { alloc, copyElems, free, type Heap } from "./ex-heap.ts";

export class Vec<T> {
  private buf: Ptr<T> | null = null;
  private len: usize = 0;
  private cap: usize = 0;
  private borrows: usize = 0;
  private dead: bool = false;

  constructor(private elem: ElemOf<T>, private heap: Heap) {}

  get length(): usize {
    this.check();
    return this.len;
  }

  private check(): void {
    if (this.dead) trap(Trap.Stale);
  }

  // SAFETY: i is below len, which is at most cap, the number of elements buf holds.
  private slot(i: usize): Ptr<T> {
    this.check();
    if (i >= this.len || this.buf === null) trap(Trap.Bounds);
    return this.buf.add(i);
  }

  // SAFETY: slot checked the index, and the Vec is alive.
  get(i: usize): T {
    return this.slot(i).read();
  }

  // SAFETY: slot checked the index, and the Vec is alive.
  set(i: usize, v: T): void {
    this.slot(i).write(v);
  }

  /** False when out of memory, and the Vec is unchanged. */
  // SAFETY: grow left len below cap, so the element at len is ours to write.
  push(v: T): bool {
    this.check();
    if (this.borrows > 0) trap(Trap.Loan);
    if (this.len === this.cap && !this.grow()) return false;
    this.buf!.add(this.len).write(v);
    this.len++;
    return true;
  }

  // SAFETY: len was above zero, so the element now at len was written by push.
  pop(): T {
    this.check();
    if (this.borrows > 0) trap(Trap.Loan);
    if (this.len === 0) trap(Trap.Bounds);
    this.len--;
    return this.buf!.add(this.len).read();
  }

  private grow(): bool {
    const cap = this.cap === 0 ? 4 : this.cap * 2;
    const next = alloc(this.heap, this.elem, cap);
    if (next === null) return false;
    if (this.buf !== null) {
      copyElems(this.elem, next, this.buf, this.len);
      free(this.heap, this.elem, this.buf, this.cap);
    }
    this.buf = next;
    this.cap = cap;
    return true;
  }

  // SAFETY: borrows stops push, pop and free moving the buffer during the loan, and a slice can't be stored.
  withSlice(f: (s: ArrayOf<T>) => void): void {
    this.check();
    if (this.buf === null) return;
    this.borrows++;
    f(sliceOf(this.elem, this.buf.addr, this.len));
    this.borrows--;
  }

  /** Elements it has room for without growing. */
  get capacity(): usize {
    this.check();
    return this.cap;
  }

  /** Gives an empty Vec's buffer back, and leaves it usable: true if there was one. */
  // SAFETY: buf holds cap elements from this heap, and nothing borrows it.
  trim(): bool {
    this.check();
    if (this.len > 0 || this.buf === null) return false;
    if (this.borrows > 0) trap(Trap.Loan);
    free(this.heap, this.elem, this.buf, this.cap);
    this.buf = null;
    this.cap = 0;
    return true;
  }

  free(): void {
    this.check();
    if (this.borrows > 0) trap(Trap.Loan);
    if (this.buf !== null) free(this.heap, this.elem, this.buf, this.cap);
    this.buf = null;
    this.dead = true;
  }

  [Symbol.dispose](): void {
    if (!this.dead) this.free();
  }
}
