// expect: TSL1006 at 5:10
import { type usize } from "@tsl/core";
type P = { readonly x: usize };
export function f(p: P): usize {
  return Object.keys(p).length;
}
