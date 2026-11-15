// expect: TSL1012 at 6:26
import { type u32 } from "@tsl/core";
class Tree {
  /** @tsl.noalloc */
  depth(n: u32): u32 {
    return n === 0 ? 0 : this.depth(n - 1) + 1;
  }
}
