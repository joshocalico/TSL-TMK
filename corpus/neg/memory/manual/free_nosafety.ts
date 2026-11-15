// expect: TSL5002 at 8:3
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";
class I {
  constructor(public v: u32) {}
}
export function f(i: I): void {
  unsafeFree(i);
}
