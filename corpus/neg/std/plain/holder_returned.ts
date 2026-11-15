// A holder that's returned goes first of all.
// expect: TSL3002 at 10:10
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class H {
  constructor(public v: Vec<u32>) {}
}
export function f(v: Vec<u32>): H {
  const h = new H(v);
  return h;
}
export const keep = new Vec(u32);
