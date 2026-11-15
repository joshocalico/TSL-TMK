// expect: TSL5005 at 8:17
import { make, u32, type u64 } from "@tsl/core";
import { addrOf } from "@tsl/unsafe";
class L { x = u32(); }
// SAFETY: a test of the checker.
export function f(): u64 {
  const s = make(L);
  return addrOf(s);
}
