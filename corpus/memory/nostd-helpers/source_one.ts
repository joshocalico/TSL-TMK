// A module that names a global allocator, for a second one to collide with.
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";

function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
export const one = globalAllocator(none);
