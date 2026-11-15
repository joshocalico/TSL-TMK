// What's read back out of a holder is the stack object it always was.
// expect: TSL3001 at 15:9
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class H {
  constructor(public v: Vec<u32>) {}
}
class G {
  v: Vec<u32> | null = null;
}
const g = new G();
export function f(): void {
  const v = new Vec(u32);
  const h = new H(v);
  g.v = h.v;
}
