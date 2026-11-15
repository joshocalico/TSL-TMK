// expect: TSL3005 at 3:10
import { type u32 } from "@tsl/core";
type U = { readonly a: u32 } | { readonly b: u32 };
export function f(u: U): u32 {
  return g(u);
}
function g(_u: U): u32 {
  return 1;
}
