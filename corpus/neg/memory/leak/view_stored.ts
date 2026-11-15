// An object held in place is a view, and has no generation: TSL3001 stays, in a leak package too.
// expect: TSL3001 at 14:10
import { type u32 } from "@tsl/core";
class Inner {
  constructor(public v: u32) {}
}
class Outer {
  inner: Inner = new Inner(1);
}
const o = new Outer();
let kept: Inner | null = null;
export function f(): u32 {
  const i = o.inner;
  kept = i;
  return kept.v;
}
