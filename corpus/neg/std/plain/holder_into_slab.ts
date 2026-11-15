// A holder that's moved into a Slab outlives what it holds.
// expect: TSL3001 at 11:16
import { u32 } from "@tsl/core";
import { Slab, Vec } from "@tsl/std";
class H {
  constructor(public v: Vec<u32>) {}
}
const hs = new Slab<H>();
export function f(): void {
  const v = new Vec(u32);
  hs.add(new H(v));
}
