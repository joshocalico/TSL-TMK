// file: ex-std-vec.ts
import { Vec as AllocVec } from "@tsl/alloc";
import { idiv, Trap, trap, type ArrayOf, type bool, type i32, type usize } from "@tsl/core";
import { checkLive, heap, type ElemOf } from "./ex-std-global.ts";

/**
 * `@tsl/alloc`'s Vec over the global allocator. Out of memory is trap 14, and `tryPush` is the form that reports it.
 * A loan (`withSlice`, `forEach`, `sortInPlace`) stops anything that moves or removes elements, with trap 13.
 */
export class Vec<T> {
  private v: AllocVec<T>;
  private loans: usize = 0;
  private freed: bool = false;

  constructor(elem: ElemOf<T>) {
    this.v = new AllocVec(elem, heap);
  }

  get length(): usize {
    return this.v.length;
  }

  get(i: usize): T {
    return this.v.get(i);
  }

  set(i: usize, x: T): void {
    this.v.set(i, x);
  }

  private noLoan(): void {
    if (this.loans > 0) trap(Trap.Loan);
  }

  push(x: T): void {
    this.noLoan();
    if (!this.v.push(x)) trap(Trap.OutOfMemory);
  }

  /** False when out of memory, and the Vec is unchanged. */
  tryPush(x: T): bool {
    this.noLoan();
    return this.v.push(x);
  }

  pop(): T {
    this.noLoan();
    return this.v.pop();
  }

  clear(): void {
    this.noLoan();
    for (let n = this.v.length; n > 0; n--) this.v.pop();
  }

  /** Moves everything from i up one place. Traps 2 past the end, and 14 out of memory. */
  insert(i: usize, x: T): void {
    this.noLoan();
    const n = this.v.length;
    if (i > n) trap(Trap.Bounds);
    if (i === n) {
      this.push(x);
      return;
    }
    this.push(this.v.get(n - 1));
    for (let at = n - 1; at > i; at--) this.v.set(at, this.v.get(at - 1));
    this.v.set(i, x);
  }

  /** Keeps the order: moves everything above i down one place, so it's linear. */
  removeAt(i: usize): T {
    this.noLoan();
    const x = this.v.get(i);
    const n = this.v.length;
    for (let at = i + 1; at < n; at++) this.v.set(at - 1, this.v.get(at));
    this.v.pop();
    return x;
  }

  /** Doesn't keep the order: the last element takes its place. */
  swapRemove(i: usize): T {
    this.noLoan();
    const x = this.v.get(i);
    const last = this.v.pop();
    if (i < this.v.length) this.v.set(i, last);
    return x;
  }

  swap(i: usize, j: usize): void {
    const a = this.v.get(i);
    this.v.set(i, this.v.get(j));
    this.v.set(j, a);
  }

  /** A value that's about to reach a closure, whose parameter nothing checks (3.5): a stale reference traps here. */
  private live(i: usize): T {
    const x = this.v.get(i);
    checkLive(x);
    return x;
  }

  forEach(f: (x: T, i: usize) => void): void {
    this.loans++;
    const n = this.v.length;
    for (let i: usize = 0; i < n; i++) f(this.live(i), i);
    this.loans--;
  }

  /** Heapsort: in place, no allocation, so it can't run out, and not stable. cmp is negative, 0 or positive, as JS's is. */
  sortInPlace(cmp: (a: T, b: T) => i32): void {
    this.loans++;
    const n = this.v.length;
    for (let i = idiv(n, 2); i > 0; i--) this.sift(i - 1, n, cmp);
    for (let end = n; end > 1; end--) {
      this.swap(0, end - 1);
      this.sift(0, end - 1, cmp);
    }
    this.loans--;
  }

  private sift(start: usize, end: usize, cmp: (a: T, b: T) => i32): void {
    let root = start;
    for (;;) {
      let child = root * 2 + 1;
      if (child >= end) return;
      if (child + 1 < end && cmp(this.live(child), this.live(child + 1)) < 0) child++;
      if (cmp(this.live(root), this.live(child)) >= 0) return;
      this.swap(root, child);
      root = child;
    }
  }

  /** Scalars only: the slice can't outlive the call, and `push`, `pop` and `free` during it trap 13. */
  withSlice(f: (s: ArrayOf<T>) => void): void {
    this.v.withSlice(f);
  }

  /** Elements it has room for without growing. */
  get capacity(): usize {
    return this.v.capacity;
  }

  /** Gives an empty Vec's buffer back, and leaves it usable: true if there was one (an `rc` release's step, D74). */
  trim(): bool {
    this.noLoan();
    return this.v.trim();
  }

  free(): void {
    this.noLoan();
    this.freed = true;
    this.v.free();
  }

  [Symbol.dispose](): void {
    if (!this.freed) this.free();
  }
}
