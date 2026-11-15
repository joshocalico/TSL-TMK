// expect: TSL1007 at 5:13
import { type u32 } from "@tsl/core";
type Tag = "a" | "b";
export function f(): u32 {
  const t = "a";
  const u: Tag = t;
  return u === "a" ? 1 : 0;
}
