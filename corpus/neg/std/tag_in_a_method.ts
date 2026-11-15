// expect: TSL1020 at 7:3
import type { u64 } from "@tsl/core";
import { Vec } from "@tsl/std";

export class C {
  /** @tsl.global-allocator */
  m(): u64 {
    return 0n;
  }
}
export type V = Vec<u64>;
