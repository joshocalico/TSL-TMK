// expect: TSL1007 at 4:13
import { type u32 } from "@tsl/core";
export function f(x: u32): u32 {
  const s = `${x}`;
  return s.length;
}
