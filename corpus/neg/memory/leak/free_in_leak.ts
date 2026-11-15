// expect: TSL5007 at 9:3
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";
class D {
  constructor(public id: u32) {}
}
export function f(d: D): u32 {
  // SAFETY: never reached: it doesn't compile.
  unsafeFree(d);
  return 1;
}
