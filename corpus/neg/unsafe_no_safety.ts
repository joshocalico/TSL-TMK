// expect: TSL5002 at 5:10
import { u32, type u32 as U32 } from "@tsl/core";
import { ptrAt } from "@tsl/unsafe";
export function f(): U32 {
  return ptrAt(u32, 64n).read();
}
