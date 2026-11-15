// expect: TSL5001 at 2:1
import { dmbIsh } from "@tsl/arch-aarch64";
class Marker {}
export function f(): void {
  dmbIsh();
}
