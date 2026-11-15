// expect: TSL9001 at 10:9
// expect-msg: a vector of counted references is a field of a counted object
import { type u32 } from "@tsl/core";
import { ref, Vec } from "@tsl/std";
class P {
  constructor(public x: u32) {}
}
export function f(): u32 {
  // dropped at scope exit it would be one decrement per element at once, so it lives in a counted object (D74)
  using v = new Vec(ref<P>());
  v.push(new P(1));
  return v.get(0).x;
}
