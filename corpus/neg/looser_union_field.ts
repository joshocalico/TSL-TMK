// expect: TSL3005 at 4:43
import { type Result, type u32 } from "@tsl/core";
export function f(r: Result<u32, u32>): boolean {
  const loose: { readonly ok: boolean } = r;
  return loose.ok;
}
