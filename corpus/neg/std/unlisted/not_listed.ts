// expect: TSL5001 at 11:1
// expect-msg: trusts its page source
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";

function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
export const h = globalAllocator(none);
