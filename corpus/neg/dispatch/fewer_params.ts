// expect: TSL1025 at 13:3
// A method taking fewer parameters passes tsc, and isn't the interface's method as TSL calls it.
import { type u32 } from "@tsl/core";
interface Pager {
  pages(n: u32): u32;
}
class A {
  pages(n: u32): u32 {
    return n;
  }
}
class B {
  pages(): u32 {
    return 2;
  }
}
function use(p: Pager): u32 {
  return p.pages(1);
}
export function f(): u32 {
  return use(new A()) + use(new B());
}
