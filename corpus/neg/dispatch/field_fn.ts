// expect: TSL1025 at 13:3
// A field holding a function passes tsc as a method, and isn't one.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
class Sq {
  area(): u32 {
    return 4;
  }
}
class Odd {
  area: () => u32 = (): u32 => 3;
}
function total(s: Shape): u32 {
  return s.area();
}
export function f(): u32 {
  return total(new Sq()) + total(new Odd());
}
