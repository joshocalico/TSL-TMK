// expect: TSL1021 at 13:1
// expect-msg: the first is at corpus/neg/std/two_same_module.ts:10:1
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";
function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
const a = globalAllocator(none);

/** @tsl.global-allocator */
const b = globalAllocator(none);
export function f(): boolean {
  return a === b;
}
