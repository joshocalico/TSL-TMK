// expect: TSL1009 at 3:1
import { type u32 } from "@tsl/core";
export async function f(): Promise<u32> {
  return 1;
}
