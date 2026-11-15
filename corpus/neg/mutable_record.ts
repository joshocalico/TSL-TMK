// expect: TSL1005 at 3:12
import { type u32 } from "@tsl/core";
type P = { x: u32 };
export function f(p: P): u32 {
  return p.x;
}
