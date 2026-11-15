// expect: TSL9001 at 13:23
// expect-msg: `this` given away in its own constructor isn't counted yet
// A constructor giving `this` to another `new` (R1c, found porting D41's corpus): the object isn't counted until `make`
// places it, after its constructor, so the other object's constructor would share what has no count (3.5, D74).
import { type u32 } from "@tsl/core";
class Env {
  constructor(public self: Box) {}
}
class Box {
  op: Env | null = null;
  constructor(public k: u32) {
    // the closure over `this` of corpus/lower/rc/cyc_churn.ts, as an environment class
    this.op = new Env(this);
  }
}
export function f(): u32 {
  return new Box(3).k;
}
