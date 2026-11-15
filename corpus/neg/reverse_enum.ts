// expect: TSL1011 at 7:10
import { type u32 } from "@tsl/core";
enum E {
  A = 1,
}
export function f(x: u32): boolean {
  return E[x] === "A";
}
