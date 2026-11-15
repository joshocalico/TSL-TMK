// expect: TSL3005 at 7:20
import { type Result, type u32 } from "@tsl/core";
type R = Result<u32, "bad">;
type Loose = { readonly ok: boolean };
class Marker {}
export function f(r: R): boolean {
  const l: Loose = r;
  return l.ok;
}
