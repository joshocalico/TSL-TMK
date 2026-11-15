// A leak package needs no unsafe, and doesn't get it for nothing.
// expect: TSL5001 at 3:1
import { unsafeFree } from "@tsl/unsafe";
export function f(o: object): void {
  unsafeFree(o);
}
