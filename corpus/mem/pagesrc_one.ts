// One implementation of PageSource in the program: the call through Heap's field should be a direct call.
import { Trap, trap, type u64, type usize } from "@tsl/core";
import { Heap } from "./pagesrc_heap.ts";
import { QuotaPages } from "./pagesrc_quota.ts";

export function churn(): usize {
  const src = new QuotaPages(3);
  const heap = new Heap(src);
  let sum: usize = 0;
  for (let i: usize = 0; i < 100; i++) {
    const a = heap.allocBytes(64);
    if (a === 0n) trap(Trap.OutOfMemory);
    heap.freeBytes(a, 64);
    sum += 1;
  }
  return sum + src.calls * 1000;
}

export function exhaust(): u64 {
  const heap = new Heap(new QuotaPages(2));
  for (let i: usize = 0; i < 10; i++) {
    if (heap.allocBytes(4096) === 0n) trap(Trap.OutOfMemory);
  }
  return 1n;
}

/** Shaped exactly like QuotaPages, and used, but never stored where a PageSource goes. */
class TwinPages {
  calls: usize = 0;
  constructor(private quota: usize) {}
  pages(n: usize): u64 {
    this.calls += 1;
    if (n > this.quota) return 0n;
    this.quota -= n;
    return 0n;
  }
}

export function twin(): usize {
  const t = new TwinPages(5);
  t.pages(2);
  return t.calls;
}
