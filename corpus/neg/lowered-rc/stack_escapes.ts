// expect: TSL3002 at 12:10
// R18: a class tagged `@tsl.stack` in a lowered `rc` package is uncounted, and its `new` is a stack object: one returned
// outlives its frame, so tslc refuses it, whatever the printer said (3.5's R18).
import { type f64 } from "@tsl/core";
/** @tsl.stack */
class P {
  x: f64 = 0;
}
function make(v: f64): P {
  const p = new P();
  p.x = v;
  return p;
}
export function f(v: f64): f64 {
  return make(v).x;
}
