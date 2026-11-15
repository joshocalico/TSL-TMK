// expect: TSL3010 at 17:16
// A type parameter could be any class, so the set of classes reaching Shape can't be told.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
class Sq {
  constructor(private s: u32) {}
  area(): u32 {
    return this.s * this.s;
  }
}
function total(s: Shape): u32 {
  return s.area();
}
function via<S extends Shape>(s: S): u32 {
  return total(s);
}
export function f(): u32 {
  return via(new Sq(3));
}
