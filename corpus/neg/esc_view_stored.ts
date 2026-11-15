// expect: TSL3001 at 11:9
import { over, u32, type u32 as U32 } from "@tsl/core";
class Wire {
  x = u32();
}
class Holder {
  w: Wire | null = null;
}
export function f(h: Holder, bytes: Uint8Array): U32 {
  const v = over(Wire, bytes, 0);
  h.w = v;
  return v.x;
}
