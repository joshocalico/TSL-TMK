// A manual package's function that hands out a raw reference, for the rule on where it can't go.
import { type u32 } from "@tsl/core";

export class Raw {
  constructor(public v: u32) {}
}

export function makeRaw(v: u32): Raw {
  return new Raw(v);
}
