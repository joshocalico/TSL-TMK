// expect: TSL5001 at 2:1
import { ptrAt } from "@tsl/unsafe";
import { u32 } from "@tsl/core";
class Marker {}
export function f(): void {
  ptrAt(u32, 0n);
}
