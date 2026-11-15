// "memory": "strict" written out is today's behaviour.
// expect: TSL3002 at 8:10
import { type u32 } from "@tsl/core";
class D {
  constructor(public id: u32) {}
}
function make(): D {
  return new D(1);
}
export function f(): u32 {
  return make().id;
}
