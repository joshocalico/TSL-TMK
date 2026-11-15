// expect: TSL2003 at 10:13
import { u32 } from "@tsl/core";
import { ref, Set } from "@tsl/std";
class K {
  hashKey(): u32 {
    return 1;
  }
}
export function f(k: K): boolean {
  using s = new Set(ref<K>());
  return s.has(k);
}
