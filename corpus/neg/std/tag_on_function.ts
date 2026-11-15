// expect: TSL1020 at 7:1
// expect-msg: @tsl.global-allocator is on the wrong thing
import type { u64, usize } from "@tsl/core";
import { Vec } from "@tsl/std";

/** @tsl.global-allocator */
export function pages(_n: usize): u64 {
  return 0n;
}
export type V = Vec<u64>;
