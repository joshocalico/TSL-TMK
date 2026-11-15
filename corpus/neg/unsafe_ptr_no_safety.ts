// expect: TSL5002 at 10:3
import { u32, type u32 as U32 } from "@tsl/core";
import { ptrAt, type Ptr } from "@tsl/unsafe";
// SAFETY: a test of the checker.
function at(): Ptr<U32> {
  return ptrAt(u32, 64n);
}
export function f(): void {
  const p = at();
  p.write(1);
}
