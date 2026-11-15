// expect: TSL1025 at 4:18
import { type u32 } from "@tsl/core";
// A generic dispatch interface: each instance would have classes of its own.
interface Holder<T> {
  get(): T;
}
class U32Box {
  get(): u32 {
    return 1;
  }
}
function read(h: Holder<u32>): u32 {
  return h.get();
}
export function f(): u32 {
  return read(new U32Box());
}
