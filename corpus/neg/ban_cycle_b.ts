// expect: TSL1010 at 2:1
import { a } from "./ban_cycle_a.ts";
export function b(): boolean {
  return a();
}
