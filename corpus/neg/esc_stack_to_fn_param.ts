// expect: TSL3001 at 7:10
import { type u32 } from "@tsl/core";
class Item {
  constructor(public id: u32) {}
}
function run(f: (i: Item) => u32): u32 {
  return f(new Item(1));
}
export function g(): u32 {
  return run((i) => i.id);
}
