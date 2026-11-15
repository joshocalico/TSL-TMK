// A method that hands back what the holder holds is handing back a stack object.
// expect: TSL3002 at 8:12
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class H {
  constructor(public v: Vec<u32>) {}
  get(): Vec<u32> {
    return this.v;
  }
}
export function f(): u32 {
  const v = new Vec(u32);
  const h = new H(v);
  return h.get().get(0);
}
