// expect: TSL3001 at 26:9
// R18: a `@tsl.stack` object stored in a counted object's field would be reachable from the counted heap, which the cycle
// collector scans, after its frame: tslc refuses it (3.5's R18).
import { type f64 } from "@tsl/core";
/** @tsl.stack */
class P {
  x: f64 = 0;
}
class Holder {
  p: P | null = null;
}
export function f(v: f64): f64 {
  const h = new Holder();
  const p = new P();
  p.x = v;
  h.p = p;
  return h.p.x;
}
