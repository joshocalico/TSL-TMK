// expect: TSL3002 at 12:10
// expect-msg: made at corpus/neg/esc_return_through_call.ts:11:13
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
function same(d: Domain): Domain {
  return d;
}
function make(): Domain {
  const a = new Domain(1);
  return same(a);
}
export function f(): u32 {
  return make().id;
}
