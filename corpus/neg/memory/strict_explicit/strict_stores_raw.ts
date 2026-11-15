// A strict package that got a raw reference from a manual one's function and stores it.
// expect: TSL3008 at 11:12
import { type u32 } from "@tsl/core";
import { makeRaw, type Raw } from "../../../memory/manual/manual_make.ts";

class Keeper {
  held: Raw | null = null;
}
const k = new Keeper();
export function f(v: u32): u32 {
  k.held = makeRaw(v);
  return v;
}
