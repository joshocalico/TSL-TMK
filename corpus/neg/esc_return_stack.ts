// expect: TSL3002 at 11:10
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
export function f(): u32 {
  const d = make();
  return d.id;
}
function make(): Domain {
  return new Domain(1);
}
