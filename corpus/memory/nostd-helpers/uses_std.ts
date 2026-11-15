// Not a noStd package itself: only a noStd package that imports this makes it wrong (D38).
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";

export function count(): u32 {
  using v = new Vec(u32);
  v.push(1);
  return v.get(0);
}
