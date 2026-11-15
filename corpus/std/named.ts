// A program naming its global allocator: every std allocation comes from its pool, on the host and natively (SPEC 3.5).
import { toU32, u32, type bool, type usize } from "@tsl/core";
import { globalAllocator, ExactMap, Vec } from "@tsl/std";
import { bytesAt } from "@tsl/unsafe";
import { limitPages, pagesUsed, poolPages } from "./pool.ts";

/** @tsl.global-allocator */
const heap = globalAllocator(poolPages);

export function fromThePool(n: usize): bool {
  const before = pagesUsed();
  using v = new Vec(u32);
  for (let i: usize = 0; i < n; i++) v.push(toU32(i));
  return pagesUsed() > before && v.length === n;
}

export function sameHeapAsVec(): bool {
  const a = heap.allocBytes(32);
  heap.freeBytes(a, 32);
  return a !== 0n;
}

// A run of whole pages that comes back is zeroed, as a page source's are, because a Heap's first page counts on it (3.5).
export function aRunComesBackZeroed(): u32 {
  const a = heap.allocBytes(8192);
  // SAFETY: a block of 8192 bytes from the allocator, and it's written and then given back.
  bytesAt(a, 8192).fill(0xab);
  heap.freeBytes(a, 8192);
  const used = pagesUsed();
  const b = heap.allocBytes(8192);
  if (pagesUsed() !== used || a !== b) return 0xffffffff; // the same run again, with no new pages
  let sum: u32 = 0;
  // SAFETY: as above.
  const bytes = bytesAt(b, 8192);
  for (const x of bytes) sum += x;
  heap.freeBytes(b, 8192);
  return sum;
}

export function runsSplitAndComeBack(): u32 {
  const big = heap.allocBytes(4096 * 8);
  heap.freeBytes(big, 4096 * 8);
  const used = pagesUsed();
  const a = heap.allocBytes(4096 * 3);
  const b = heap.allocBytes(4096 * 2);
  const c = heap.allocBytes(4096 * 3);
  const ok = pagesUsed() === used && a === big && b === big + 12288n && c === big + 20480n ? 1 : 0;
  heap.freeBytes(c, 4096 * 3);
  heap.freeBytes(a, 4096 * 3);
  heap.freeBytes(b, 4096 * 2);
  return ok;
}

export function exhaustTry(): u32 {
  limitPages(4);
  using v = new Vec(u32);
  let n: u32 = 0;
  while (v.tryPush(n)) n++;
  // Unchanged after a failure, and readable.
  return n === toU32(v.length) && v.get(toU32(v.length) - 1) === n - 1 ? n : 0xffffffff;
}

export function exhaustTrap(): u32 {
  limitPages(4);
  using v = new Vec(u32);
  for (let n: u32 = 0; n < 100000000; n++) v.push(n);
  return 0;
}

export function mapTrySet(): u32 {
  limitPages(8);
  using m = new ExactMap(u32, u32);
  let n: u32 = 0;
  while (m.trySet(n, n * 2)) n++;
  let ok: u32 = 0;
  for (let i: u32 = 0; i < n; i++) if (m.get(i) === i * 2) ok++;
  return ok === n && toU32(m.size) === n ? n : 0xffffffff;
}
