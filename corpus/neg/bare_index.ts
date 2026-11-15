// expect: TSL1008 at 4:13
import { type u8 } from "@tsl/core";
export function f(a: Uint8Array): u8 {
  const v = a[0];
  return v!;
}
