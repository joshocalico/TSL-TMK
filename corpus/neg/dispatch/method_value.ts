// expect: TSL1025 at 20:24
// A dispatch interface's method is only called, never read as a value.
import { type u32 } from "@tsl/core";
interface Shape {
  area(): u32;
}
class Sq {
  area(): u32 {
    return 4;
  }
}
class Tri {
  area(): u32 {
    return 3;
  }
}
const all: u32 = 0;
function pick(s: Shape): u32 {
  if (all > 0) return 0;
  const g: () => u32 = s.area;
  return g();
}
export function f(): u32 {
  return pick(new Sq()) + pick(new Tri());
}
