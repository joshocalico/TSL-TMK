// expect: TSL1025 at 14:3
// tsc sees number for both, TSL a u32 and a usize: each class's method has to take and give the interface's types.
import { type u32, type usize } from "@tsl/core";
interface Pager {
  pages(n: u32): u32;
}
class A {
  pages(n: u32): u32 {
    return n;
  }
}
class B {
  // Not the interface's types, as TSL has them.
  pages(n: usize): u32 {
    return 2;
  }
}
function use(p: Pager): u32 {
  return p.pages(1);
}
export function f(): u32 {
  return use(new A()) + use(new B());
}
