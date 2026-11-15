// Passed to a strict method that stores it.
// expect: TSL3008 at 9:10
// expect-msg: Holder.keep
import { type u32 } from "@tsl/core";
import { Holder, Thing } from "../../../memory/holder.ts";

const h = new Holder();
export function f(v: u32): u32 {
  h.keep(new Thing(v));
  return v;
}
