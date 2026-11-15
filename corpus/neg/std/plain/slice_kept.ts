// A slice can't get out of its loan by way of a local the closure captures.
// expect: TSL3003 at 10:12
import { type ArrayOf, u32 } from "@tsl/core";
import { Vec } from "@tsl/std";

const empty = new Uint32Array(0);
export function f(v: Vec<u32>): u32 {
  let kept: ArrayOf<u32> = empty;
  v.withSlice((s) => {
    kept = s;
  });
  v.push(9);
  return kept[0]!;
}
