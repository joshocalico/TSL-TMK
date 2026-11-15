// expect: TSL2001 at 8:9 // expect: TSL1006 at 8:13
import { type i32 } from "@tsl/core";
function one(x: i32): i32 {
  return x;
}
const T = [one];
export function f(x: i32): i32 {
  const g = T;
  return g[0]!(x);
}
