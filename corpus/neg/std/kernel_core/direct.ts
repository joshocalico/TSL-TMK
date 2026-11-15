// A package set up as kernel-core is (5.6, D38): noStd and strict. Importing the real package is TSL1018.
// expect: TSL1018 at 4:1
// expect-file: corpus/neg/std/kernel_core/direct.ts
import { Vec } from "@tsl/std";
export function f(): number {
  return new Vec(1 as never).length;
}
