// expect: TSL1020 at 10:1
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";

function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
export let h = globalAllocator(none);
