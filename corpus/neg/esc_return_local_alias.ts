// expect: TSL3002 at 9:10
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
function make(): Domain {
  const a = new Domain(1);
  const b = a;
  return b;
}
export function f(): u32 {
  return make().id;
}
