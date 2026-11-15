// expect: TSL1015 at 5:17
import { sizeOf, type u32, type usize } from "@tsl/core";
class P { x: u32 = 0; }
export function f(): usize {
  return sizeOf(P);
}
