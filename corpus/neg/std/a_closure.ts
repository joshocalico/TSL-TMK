// expect: TSL5009 at 5:27
import { globalAllocator } from "@tsl/std";

/** @tsl.global-allocator */
const h = globalAllocator((_n) => 0n);
export function f(): boolean {
  return h.allocBytes(1) === 0n;
}
