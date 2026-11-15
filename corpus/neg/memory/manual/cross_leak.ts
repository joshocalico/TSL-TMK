// A leak package is as safe as a strict one, so a raw reference doesn't go there either.
// expect: TSL3008 at 9:12
import { type u32 } from "@tsl/core";
import { Keep, Slot } from "../../../memory/leak/leak_store.ts";

const k = new Keep();
export function f(v: u32): u32 {
  const s = new Slot(v);
  k.held = s;
  return v;
}
