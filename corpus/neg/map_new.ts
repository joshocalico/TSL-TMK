// expect: TSL1006 at 4:17
import { type u32 } from "@tsl/core";
export function f(): u32 {
  const m = new Map<u32, u32>();
  return m.size;
}
