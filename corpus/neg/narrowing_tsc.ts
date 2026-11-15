// expect: TS2322 at 4:9
import { type u32, type u8 } from "@tsl/core";
export function f(a: u32): u8 {
  const r: u8 = a;
  return r;
}
