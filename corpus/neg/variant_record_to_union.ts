// expect: TSL3005 at 7:10
import { type Ok, type Result, type u32 } from "@tsl/core";
function ok(x: u32): Ok<u32> {
  return { ok: true, value: x };
}
export function f(x: u32): Result<u32, u32> {
  return ok(x);
}
