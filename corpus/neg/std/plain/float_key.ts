// expect: TSL2003 at 5:13
import { f64 } from "@tsl/core";
import { Map, Vec } from "@tsl/std";
export function f(): boolean {
  using m = new Map(f64, f64);
  return m.has(1.5);
}
export type V = Vec<f64>;
