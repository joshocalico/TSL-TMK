// expect: TSL3004 at 3:10
import { type u32 } from "@tsl/core";
type P = {
  readonly a: u32;
  readonly b: u32;
  readonly c: u32;
  readonly d: u32;
  readonly e: u32;
};
export function f(p: P): u32 {
  return p.a;
}
