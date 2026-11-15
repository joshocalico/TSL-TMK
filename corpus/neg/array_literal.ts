// expect: TSL1006 at 4:14
import { type u32 } from "@tsl/core";
export function f(): u32 {
  const xs = [1, 2, 3];
  return xs[0]!;
}
