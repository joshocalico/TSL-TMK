// A stack object made in a loop has its slot reused, so a holder outside can't keep it.
// expect: TSL3001 at 12:11
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class H {
  v: Vec<u32> | null = null;
}
export function f(): void {
  const h = new H();
  for (let i: u32 = 0; i < 3; i++) {
    const v = new Vec(u32);
    h.v = v;
  }
}
