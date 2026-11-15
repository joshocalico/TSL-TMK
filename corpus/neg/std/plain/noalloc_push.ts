// expect: TSL1017 at 6:3
import { u32 } from "@tsl/core";
import { Vec } from "@tsl/std";
/** @tsl.noalloc */
export function f(v: Vec<u32>): void {
  v.push(1);
}
