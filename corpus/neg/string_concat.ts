// expect: TSL1007 at 4:13
import { type u32 } from "@tsl/core";
export function f(): u32 {
  const s = "a" + "b";
  return s === "ab" ? 1 : 0;
}
