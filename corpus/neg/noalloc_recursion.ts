// expect: TSL1012 at 8:10
import { type u32 } from "@tsl/core";
/** @tsl.noalloc */
export function f(n: u32): u32 {
  return n === 0 ? 0 : g(n - 1);
}
function g(n: u32): u32 {
  return f(n);
}
