// expect: TSL3010 at 7:7
// A generic class reaching an interface: each of its instances would be a class of its own.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
class Box<T> {
  constructor(private v: T) {}
  area(): u32 {
    return 1;
  }
}
function total(s: Shape): u32 {
  return s.area();
}
export function f(): u32 {
  return total(new Box<u32>(2));
}
