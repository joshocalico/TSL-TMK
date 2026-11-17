// expect: TSL3001 at 12:10
// R18: a `@tsl.stack` object kept in module state outlives its frame: tslc refuses it (3.5's R18).
import { type f64 } from "@tsl/core";
/** @tsl.stack */
class P {
  x: f64 = 0;
}
let last: P | null = null;
export function f(v: f64): f64 {
  const p = new P();
  p.x = v;
  last = p;
  return last.x;
}
