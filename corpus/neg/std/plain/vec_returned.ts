// A Vec made in a function is a stack object in strict, like anything else made in a function.
// expect: TSL3002 at 7:10
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
export function f(): Vec<u32> {
  const v = new Vec(u32);
  return v;
}
