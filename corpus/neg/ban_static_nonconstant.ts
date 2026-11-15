// expect: TSL1010 at 8:24
import { type u32 } from "@tsl/core";
class C {
  constructor(public v: u32) {}
}
let n: u32 = 0;
export function f(): void { n = 1; }
export const c = new C(n);
