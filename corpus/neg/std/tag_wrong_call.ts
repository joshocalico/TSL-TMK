// expect: TSL1020 at 12:1
// expect: TSL1020 at 15:1
import { Heap } from "@tsl/alloc";
import type { u64, usize } from "@tsl/core";
import { Vec } from "@tsl/std";

function none(_n: usize): u64 {
  return 0n;
}

/** @tsl.global-allocator */
export const h = new Heap(none);

/** @tsl.global-allocator */
export class NotThisEither {}
export type V = Vec<u64>;
