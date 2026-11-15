// expect: TS2322 at 4:3
import { type i32, type u32 } from "@tsl/core";
export function f(a: i32): u32 {
  return a;
}
