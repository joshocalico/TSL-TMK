// expect: TSL2002 at 4:16
import { type u32 } from "@tsl/core";
export function f(x: u32): boolean {
  return x === -1;
}
