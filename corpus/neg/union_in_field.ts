// expect: TSL3005 at 3:17
import { type Result, type u32 } from "@tsl/core";
type Holder = { readonly r: Result<u32, u32> };
export function f(h: Holder): u32 {
  return h.r.ok ? 1 : 0;
}
