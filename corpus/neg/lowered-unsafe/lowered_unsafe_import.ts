// expect: TSL1023 at 1:14
// expect-file: corpus/neg/lowered-unsafe/tsl.json
// R18 (the owner's ruling, 2027-01-01: lowered TSL has no way of violating memory safety): a lowered package can't list
// "unsafeModules", so none of its modules can import @tsl/unsafe (TSL5001 without the listing, TSL1023 with it).
import { u64 } from "@tsl/core";
import { ptrAt } from "@tsl/unsafe";
export function peek(a: u64): u64 {
  // SAFETY: none; this package mustn't compile.
  return ptrAt(u64, a).read();
}
