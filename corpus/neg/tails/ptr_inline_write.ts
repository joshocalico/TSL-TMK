// expect: TSL3011 at 11:36
import { tail, u8, withTail, type u32, type u64 } from "@tsl/core";
import { inlineOf, ptrAt } from "@tsl/unsafe";
class Buf {
  n: u32 = 0;
  data = tail(u8);
}
export function put(at: u64): u32 {
  const b = withTail(2, new Buf());
  // SAFETY: a test of the checker only.
  ptrAt(inlineOf<Buf>(), at).write(b);
  return b.n;
}
