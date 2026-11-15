// expect: TSL1010 at 2:1
import { b } from "./ban_cycle_b.ts";
export function a(): boolean {
  return b();
}
