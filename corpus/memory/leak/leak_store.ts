// A leak package's class, for the rule on what a raw reference can't be stored in.
import { type u32 } from "@tsl/core";

export class Slot {
  constructor(public v: u32) {}
}

export class Keep {
  held: Slot | null = null;
}
