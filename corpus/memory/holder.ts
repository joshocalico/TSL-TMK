// A strict package's class with a stored reference: it checks a generation on every access through it.
import { type u32 } from "@tsl/core";

export class Thing {
  constructor(public v: u32) {}
}

export class Holder {
  held: Thing | null = null;
  keep(t: Thing): void {
    this.held = t;
  }
  read(): u32 {
    return this.held === null ? 0 : this.held.v;
  }
}

export function total(a: u32, b: u32): u32 {
  return a + b;
}
