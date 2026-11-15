// expect: TSL3010 at 7:22
// Nothing in the program is ever a Shape, so what a value of it is can't be told.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
export function f(s: Shape): u32 {
  return s.area();
}
