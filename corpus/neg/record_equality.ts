// expect: TSL2020 at 5:10
import { type u32 } from "@tsl/core";
type P = { readonly x: u32 };
export function f(a: P, b: P): boolean {
  return a === b;
}
