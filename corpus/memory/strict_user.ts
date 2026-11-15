// A strict package using a manual one through its safe API: only values cross.
import { type u32 } from "@tsl/core";
import { get, put, removeAll } from "./manual/manual_wrap.ts";
import { total } from "./holder.ts";

export function roundTrip(a: u32, b: u32): u32 {
  put(1, a);
  put(2, b);
  return total(get(1), get(2));
}

export function clear(): u32 {
  return removeAll();
}
