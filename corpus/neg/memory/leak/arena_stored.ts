// An arena's loan dies at its scope's end: leak makes `new` last, not a loan. TSL3001 stays.
// expect: TSL3001 at 13:9
import { arenaOver, u32, type u32 as U32 } from "@tsl/core";
class Wire {
  x = u32();
}
class Holder {
  w: Wire | null = null;
}
export function f(h: Holder, bytes: Uint8Array): U32 {
  using a = arenaOver(bytes);
  const v = a.make(Wire);
  h.w = v;
  return v.x;
}
