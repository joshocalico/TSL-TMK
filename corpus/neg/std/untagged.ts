// expect: TSL1020 at 9:18
// expect-msg: with no @tsl.global-allocator tag
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";

function none(_n: usize): u64 {
  return 0n;
}
export const h = globalAllocator(none);
