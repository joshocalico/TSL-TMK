// expect: TSL9001 at 7:7
// expect-msg: a top-level counted object isn't supported yet
import { type u32 } from "@tsl/core";
class P {
  constructor(public x: u32) {}
}
const p = new P(1);
export function f(): u32 {
  return p.x;
}
