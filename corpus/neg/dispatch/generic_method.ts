// expect: TSL1025 at 5:3
import { type u32 } from "@tsl/core";
// A generic method: each class would need every instance of it.
interface Echo {
  echo<T>(x: T): T;
}
export function f(): u32 {
  return 1;
}
