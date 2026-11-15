// An escaping new allocates, so a @tsl.noalloc path can't have one.
// expect: TSL1017 at 10:13
import { type u32 } from "@tsl/core";
class N {
  constructor(public v: u32) {}
}
let kept: N | null = null;
/** @tsl.noalloc */
export function f(v: u32): u32 {
  const n = new N(v);
  kept = n;
  return kept.v;
}
