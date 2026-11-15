// expect: TSL1015 at 5:15
import { over, type u32 } from "@tsl/core";
class P { x: u32 = 0; }
export function f(b: Uint8Array): u32 {
  return over(P, b, 0).x;
}
