// expect: TSL5008 at 10:14
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";
class I {
  constructor(public v: u32) {}
}
const s = new I(1);
export function f(): void {
  // SAFETY: never reached: it doesn't compile.
  unsafeFree(s);
}
