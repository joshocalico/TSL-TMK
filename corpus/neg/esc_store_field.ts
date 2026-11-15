// expect: TSL3001 at 11:13
// expect-msg: stack object
class Domain {
  constructor(public id: u32) {}
}
class Timer {
  owner: Domain | null = null;
}
export function f(t: Timer): void {
  const d = new Domain(1);
  t.owner = d;
}
import { type u32 } from "@tsl/core";
