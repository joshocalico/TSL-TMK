// memory-pages: 1
// setPageSource replaces the source @tsl/std's default allocator asks, as it does for `leak` and `manual` (SPEC 3.5, D43): the test
// image's limit here is one page, and the pool's is what the program sets.
import { toU32, u32, type u64, type usize } from "@tsl/core";
import { setPageSource } from "@tsl/unsafe";
import { Vec } from "@tsl/std";
import { limitPages, pagesUsed, poolPages } from "./pool.ts";

function source(n: usize): u64 {
  return poolPages(n);
}

export function replaced(pages: usize): usize {
  limitPages(pages);
  const before = pagesUsed();
  // SAFETY: the pool hands out zeroed runs from a static array, each once, and 0n when it's out.
  setPageSource(source);
  using v = new Vec(u32);
  for (let i: u32 = 0; i < 20000; i++) v.push(i);
  return pagesUsed() - before;
}

export function replacedRunsOut(): u32 {
  limitPages(0);
  using v = new Vec(u32);
  for (let i: u32 = 0; i < 100000000; i++) v.push(i);
  return 0;
}
