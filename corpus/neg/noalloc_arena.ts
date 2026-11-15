// expect: TSL1017 at 5:13
import { arenaOver, type usize } from "@tsl/core";
/** @tsl.noalloc */
export function f(b: Uint8Array): usize {
  using a = arenaOver(b);
  return a.bytes(1).length;
}
