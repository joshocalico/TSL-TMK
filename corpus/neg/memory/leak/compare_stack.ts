// A stack object is still a stack object when it doesn't escape.
// expect: TSL2020 at 9:10
import { type bool, type u32 } from "@tsl/core";
class N {
  constructor(public v: u32) {}
}
export function f(): bool {
  const a = new N(1);
  return a === new N(1);
}
