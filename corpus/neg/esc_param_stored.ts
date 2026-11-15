// expect: TSL3001 at 14:14
// expect-msg: stores it at corpus/neg/esc_param_stored.ts:10:18
import { type u32 } from "@tsl/core";
class Domain {
  constructor(public id: u32) {}
}
class Timer {
  owner: Domain | null = null;
  setOwner(d: Domain): void {
    this.owner = d;
  }
}
export function f(t: Timer): u32 {
  t.setOwner(new Domain(1));
  return 0;
}
