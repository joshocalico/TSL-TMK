// A leak reference in a strict package's stored field: it has a generation that never changes, so strict's check
// passes, and it can't go stale (SPEC 3.5).
import { type u32 } from "@tsl/core";
import { Holder, Thing } from "../holder.ts";

const holder = new Holder();

function make(v: u32): Thing {
  return new Thing(v);
}

export function holdInStrict(v: u32): u32 {
  holder.keep(make(v));
  return holder.read();
}

export function directNewToStrict(v: u32): u32 {
  holder.keep(new Thing(v)); // an escaping new: the strict method stores its parameter
  return holder.read();
}
