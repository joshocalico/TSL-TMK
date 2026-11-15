// A holder someone else made can outlive a local.
// expect: TSL3001 at 10:9
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class H {
  v: Vec<u32> | null = null;
}
export function f(h: H): void {
  const v = new Vec(u32);
  h.v = v;
}
