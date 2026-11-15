// expect: TSL1017 at 7:12
import { type u32 } from "@tsl/core";
class Box {
  constructor(public f: (x: u32) => u32) {}
  /** @tsl.noalloc */
  run(x: u32): u32 {
    return this.f(x);
  }
}
