// expect: TSL5009 at 12:27
import type { u64, usize } from "@tsl/core";
import { globalAllocator } from "@tsl/std";

class S {
  f(_n: usize): u64 {
    return 0n;
  }
}
const s = new S();
/** @tsl.global-allocator */
const h = globalAllocator(s.f);
export function f(): boolean {
  return h.allocBytes(1) === 0n;
}
