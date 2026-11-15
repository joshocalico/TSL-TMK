// expect: TSL3003 at 9:14
import { type u32 } from "@tsl/core";
class Item {
  m(x: u32): u32 { return x; }
}
function run(f: (x: u32) => u32): u32 { return f(1); }
export function g(): u32 {
  const i = new Item();
  return run(i.m);
}
