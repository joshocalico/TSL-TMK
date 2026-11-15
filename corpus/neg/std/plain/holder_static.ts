// A static holder outlives everything.
// expect: TSL3001 at 14:12
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class L {
  v: Vec<u32> | null = null;
  attach(v: Vec<u32>): void {
    this.v = v;
  }
}
const l = new L();
export function f(): void {
  const v = new Vec(u32);
  l.attach(v);
}
