// expect: TSL3003 at 7:12
import { type u32 } from "@tsl/core";
function add(x: u32): u32 { return x; }
class Slot { constructor(public f: (x: u32) => u32) {} }
const slot = new Slot(add);
export function g(k: u32): void {
  slot.f = (x) => x + k;
}
