// expect: TSL1003 at 5:10
import { type Result, type u32 } from "@tsl/core";
class Marker {}
export function f(x: { readonly ok: true; readonly value: u32 }): Result<u32, "bad"> {
  return x as Result<u32, "bad">;
}
