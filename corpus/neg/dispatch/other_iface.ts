// expect: TSL3010 at 20:16
// A value of another interface, even of the same shape: its classes aren't counted as Shape's.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
interface Sized {
  area(): u32;
}
class Sq {
  area(): u32 {
    return 4;
  }
}
function total(s: Shape): u32 {
  return s.area();
}
export function f(): u32 {
  const z: Sized = new Sq();
  return total(z);
}
