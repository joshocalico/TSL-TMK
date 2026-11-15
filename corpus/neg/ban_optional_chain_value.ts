// expect: TSL1008 at 7:10
import { type u32 } from "@tsl/core";
class N {
  next: N | null = null;
}
export function f(n: N): boolean {
  return n.next?.next === null;
}
