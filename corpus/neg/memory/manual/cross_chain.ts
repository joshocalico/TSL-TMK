// Forwarded through a manual helper: it's reported where it crosses out of the package.
// expect: TSL3008 at 8:10
import { type u32 } from "@tsl/core";
import { Holder, Thing } from "../../../memory/holder.ts";

const h = new Holder();
function hand(t: Thing): void {
  h.keep(t);
}
export function f(v: u32): u32 {
  hand(new Thing(v));
  return v;
}
