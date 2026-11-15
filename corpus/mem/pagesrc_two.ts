// Two implementations: a Heap over each, allocating and freeing, and exhaustion trapping 14.
import { Trap, trap, type u64, type usize } from "@tsl/core";
import { Heap } from "./pagesrc_heap.ts";
import { QuotaPages } from "./pagesrc_quota.ts";
import { RangePages } from "./pagesrc_range.ts";

function work(heap: Heap, rounds: usize): usize {
  let live: usize = 0;
  for (let i: usize = 0; i < rounds; i++) {
    const a = heap.allocBytes(512);
    if (a === 0n) return live;
    const b = heap.allocBytes(32);
    if (b === 0n) return live;
    heap.freeBytes(b, 32);
    live += 1;
  }
  return live;
}

export function quotaHeap(): usize {
  const src = new QuotaPages(4);
  const n = work(new Heap(src), 100);
  return n * 1000 + src.calls;
}

export function rangeHeap(): usize {
  const src = new RangePages(3);
  const n = work(new Heap(src), 100);
  return n * 1000 + src.calls;
}

export function bothHeaps(): usize {
  const q = new QuotaPages(2);
  const r = new RangePages(2);
  const hq = new Heap(q);
  const hr = new Heap(r);
  let s: usize = 0;
  for (let i: usize = 0; i < 5; i++) {
    const a = hq.allocBytes(1024);
    const b = hr.allocBytes(1024);
    if (a !== 0n) s += 1;
    if (b !== 0n) s += 100;
    if (a !== 0n) hq.freeBytes(a, 1024);
  }
  return s * 1000 + q.calls * 100 + r.calls;
}

export function exhaustQuota(): u64 {
  const heap = new Heap(new QuotaPages(2));
  for (let i: usize = 0; i < 10; i++) {
    if (heap.allocBytes(4096) === 0n) trap(Trap.OutOfMemory);
  }
  return 1n;
}

export function exhaustRange(): u64 {
  const heap = new Heap(new RangePages(2));
  for (let i: usize = 0; i < 10; i++) {
    if (heap.allocBytes(2048) === 0n) trap(Trap.OutOfMemory);
  }
  return 1n;
}
