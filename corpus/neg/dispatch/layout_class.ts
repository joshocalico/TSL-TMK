// expect: TSL1025 at 13:7
// A layout class declares every byte of itself, so there's no room for a class id.
import { make, u32 } from "@tsl/core";
interface Sized {
  size(): u32;
}
class Plain {
  size(): u32 {
    return 1;
  }
}
// Its bytes are its two fields, as declared.
class Desc {
  len = u32();
  flags = u32();
  size(): u32 {
    return this.len;
  }
}
function get(s: Sized): u32 {
  return s.size();
}
export function f(): u32 {
  return get(new Plain()) + get(make(Desc, { len: 3, flags: 0 }));
}
