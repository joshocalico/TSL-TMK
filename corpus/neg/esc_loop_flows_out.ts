// expect: TSL3007 at 10:12
import { type u32, type usize } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
export function f(n: usize): u32 {
  let last: Item | null = null;
  for (let i: usize = 0; i < n; i++) {
    const x = new Item(1);
    last = x;
  }
  return last === null ? 0 : last.id;
}
