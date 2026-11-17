// expect: TSL9001 at 10:7
// expect-msg: is tagged @tsl.stack, but has a field
// R18: a `@tsl.stack` class holds numbers and booleans alone: one holding a reference would hold a count no one gives back
// when its frame ends, so tslc's expansion refuses the tag (3.5's R18).
import { type f64 } from "@tsl/core";
class Q {
  v: f64 = 0;
}
/** @tsl.stack */
class P {
  q: Q | null = null;
}
export function f(v: f64): f64 {
  const p = new P();
  const q = new Q();
  q.v = v;
  p.q = q;
  return p.q.v;
}
