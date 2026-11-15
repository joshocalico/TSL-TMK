// A slice can't get out of its loan by way of module state: a top-level array is a constant binding.
// expect: TSL1010 at 9:26
// expect: TSL9001 at 12:5
// expect: TSL9001 at 15:10
import { type ArrayOf, u32 } from "@tsl/core";
import { Vec } from "@tsl/std";

const empty = new Uint32Array(0);
let kept: ArrayOf<u32> = empty;
export function f(v: Vec<u32>): u32 {
  v.withSlice((s) => {
    kept = s;
  });
  v.push(9);
  return kept[0]!;
}
