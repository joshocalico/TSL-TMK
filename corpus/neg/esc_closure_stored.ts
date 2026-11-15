// expect: TSL3003 at 7:9
import { type u32 } from "@tsl/core";
class Box {
  constructor(public f: (x: u32) => u32) {}
}
export function g(b: Box, k: u32): void {
  b.f = (x) => x + k;
}
