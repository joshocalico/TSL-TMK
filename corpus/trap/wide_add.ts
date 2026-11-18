// R25: the AArch64 backend's add of two values held zero-extended from 32 bits or fewer, which can't carry, is a plain add at
// -O1 and -O2; an add with a wider operand keeps its test. A u64 at its limit plus a u32 traps; two u32s, or a u32 and a
// u16, as a u64 give their sum. (The same add of `ix` also drops its 2^53 test natively, but wasm32's `ix` is 32 bits, where
// those sums trap, so this corpus, which runs on both, pins the u64 form; the `ix` form is every view read of corpus/lower/r25
// natively.)
import { toU64, type u16, type u32, type u64 } from "@tsl/core";

export function u64PlusU32(a: u64, b: u32): u64 {
  return a + toU64(b);
}

export function u32PlusU64(a: u32, b: u64): u64 {
  return toU64(a) + b;
}

export function u32sAsU64(a: u32, b: u32): u64 {
  return toU64(a) + toU64(b);
}

export function u32U16AsU64(a: u32, b: u16): u64 {
  return toU64(a) + toU64(b);
}
