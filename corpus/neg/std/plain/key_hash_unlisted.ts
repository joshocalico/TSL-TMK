// A hash can depend on an address, so asking for one is unsafe: safe code gets it through a Map.
// expect: TSL5001 at 4:1
import type { u32 } from "@tsl/core";
import { keyHash } from "@tsl/unsafe";
export function f(x: u32): u32 {
  return keyHash(x);
}
