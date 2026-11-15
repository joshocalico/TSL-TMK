// expect: TSL3003 at 4:10
import { type u32 } from "@tsl/core";
function mk(k: u32): (x: u32) => u32 {
  return (x: u32): u32 => x + k;
}
export function g(): u32 {
  return mk(1)(2);
}
