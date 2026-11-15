// A raw reference in a strict class's field: nothing could check it there.
// expect: TSL3008 at 9:12
import { type u32 } from "@tsl/core";
import { Holder, Thing } from "../../../memory/holder.ts";

const h = new Holder();
export function f(v: u32): u32 {
  const t = new Thing(v);
  h.held = t;
  return v;
}
