// expect: TSL1025 at 5:10
import { type u32 } from "@tsl/core";
// A function argument would have to reach each class's arm.
interface Each {
  forAll(f: (x: u32) => void): void;
}
export function f(): u32 {
  return 1;
}
