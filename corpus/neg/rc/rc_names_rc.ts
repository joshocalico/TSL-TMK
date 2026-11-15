// expect: TSL9001 at 6:10
// expect-msg: a package that counts by hand isn't an rc package
// An rc package's module naming @tsl/gc's Rc (R1b): its classes are counted by tslc alone, so a store written by hand for
// one could count it wrongly where tslc checks nothing (3.5, D74).
import { type u32 } from "@tsl/core";
import { Rc, rcLive } from "@tsl/gc";
class P {
  constructor(public x: u32) {}
}
export function f(): u32 {
  return new P(rcLive() === 0 ? 1 : 2).x;
}
