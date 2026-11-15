// expect: TSL3004 at 3:51
import { type u32 } from "@tsl/core";
type Node = { readonly value: u32; readonly next: Node };
export function f(n: Node): u32 {
  return n.value;
}
