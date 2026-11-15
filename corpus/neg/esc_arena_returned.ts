// expect: TSL3002 at 5:10
import { arenaOver, type usize } from "@tsl/core";
function f(bytes: Uint8Array, n: usize): Uint8Array {
  using a = arenaOver(bytes);
  return a.bytes(n);
}
export function g(b: Uint8Array): usize {
  return f(b, 1).length;
}
