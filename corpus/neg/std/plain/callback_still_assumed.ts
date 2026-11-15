// The third known limit stays: a function value is assumed to store what it's given, and capturing is what to do instead.
// expect: TSL3001 at 7:3
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
function scoped(f: (v: Vec<u32>) => void): void {
  using v = new Vec(u32);
  f(v);
}
export function g(): void {
  scoped((v) => {
    v.push(1);
  });
}
