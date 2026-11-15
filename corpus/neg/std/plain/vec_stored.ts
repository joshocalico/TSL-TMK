// expect: TSL3001 at 11:14
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
class Holder {
  v: Vec<u32> | null = null;
}
const holder = new Holder();
export function f(): void {
  const v = new Vec(u32);
  v.push(1);
  holder.v = v;
}
