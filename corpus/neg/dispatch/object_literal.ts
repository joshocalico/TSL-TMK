// expect: TSL1005 at 16:5
// expect-msg: have no class to call them by
// An object literal has no class, so there's no class to call its methods by.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
function total(s: Shape): u32 {
  return s.area();
}
export function f(): u32 {
  return total(new Sq());
}
export function g(): u32 {
  return total({
    area(): u32 {
      return 1;
    },
  });
}
class Sq {
  area(): u32 {
    return 4;
  }
}
