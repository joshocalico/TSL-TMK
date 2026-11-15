// TSL proper's capturing closures keep TSL3003: only down-lowering has an environment struct for them.
// expect: TSL3003 at 12:9
import { type u32 } from "@tsl/core";
function zero(): u32 {
  return 0;
}
class C {
  f: () => u32 = zero;
}
const c = new C();
export function g(k: u32): void {
  c.f = () => k;
}
