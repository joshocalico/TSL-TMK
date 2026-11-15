// expect: TSL1024 at 4:16
import { tail, withTail, u8, u16, toU32, toUsize, type u32 } from "@tsl/core";
export function f(): u32 {
  return toU32(tail(u8).length);
}
