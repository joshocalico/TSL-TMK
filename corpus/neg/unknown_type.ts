// expect: TSL1003 at 4:12
import { type u32 } from "@tsl/core";
export function f(x: u32): u32 {
  const y: unknown = x;
  return y === x ? 1 : 0;
}
