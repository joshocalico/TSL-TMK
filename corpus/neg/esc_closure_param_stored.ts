// expect: TSL3003 at 7:21
// expect-msg: stores it at corpus/neg/esc_closure_param_stored.ts:4:25
import { type u32 } from "@tsl/core";
class Box { constructor(public f: (x: u32) => u32) {} }
export function g(k: u32): u32 {
  const f = (x: u32): u32 => x + k;
  const b = new Box(f);
  return k;
}
