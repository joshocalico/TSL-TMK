// expect: TSL1025 at 7:16
import { type u32 } from "@tsl/core";
// A dispatch interface says all its methods itself.
interface Base {
  a(): u32;
}
interface More extends Base {
  b(): u32;
}
export function f(): u32 {
  return 1;
}
