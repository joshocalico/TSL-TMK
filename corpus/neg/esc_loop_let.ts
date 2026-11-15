// expect: TSL3007 at 9:13
// expect: TSL3007 at 10:9
import { type u32, type usize } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
export function f(n: usize): u32 {
  for (let i: usize = 0; i < n; i++) {
    let x = new Item(1);
    x = new Item(2);
  }
  return 0;
}
