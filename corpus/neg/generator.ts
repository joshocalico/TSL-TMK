// expect: TSL1009 at 3:1
import { type u32 } from "@tsl/core";
export function* f(): Generator<u32> {
  yield 1;
}
