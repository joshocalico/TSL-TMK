// expect: TSL3001 at 21:9
// expect-msg: passes it on at corpus/neg/esc_chain.ts:17:10
// expect-msg: passes it on at corpus/neg/esc_chain.ts:14:9
// expect-msg: stores it at corpus/neg/esc_chain.ts:11:11
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
let saved: Domain | null = null;
function third(d: Domain): void {
  saved = d;
}
function second(d: Domain): void {
  third(d);
}
function first(d: Domain): void {
  second(d);
}
export function f(): u32 {
  const local = new Domain(1);
  first(local);
  return local.id;
}
