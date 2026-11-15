// A stub for the package that doesn't exist yet, found by its path.
// expect: TSL1018 at 3:1
import { x } from "../../../memory/tsl-std/index.ts";
export function f(): number {
  return x;
}
