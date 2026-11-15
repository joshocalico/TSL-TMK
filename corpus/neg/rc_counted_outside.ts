// expect: TSL9001 at 7:10
// expect-msg: a counted object stays there
// A strict module holding an rc package's counted object (R1b): nothing outside the package may hold or count one, as
// every count of it is the expansion's, which is what lets tslc check nothing on its references (3.5, D74).
import { type u32 } from "@tsl/core";
// Group is counted in corpus/rc; a function giving one counts as holding one
import { total, Group } from "../rc/rc_shapes.ts";
export function f(g: Group): u32 {
  return total(g);
}
