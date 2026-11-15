// expect: TSL1003 at 4:10
import { type Result, type u32 } from "@tsl/core";
export function f(x: u32): Result<u32, u32> {
  return { ok: x === 0, value: x } as Result<u32, u32>;
}
