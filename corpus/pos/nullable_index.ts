// SPEC 3.3, rule 12: a typed array's a[i], narrowed by === undefined, is a nullable scalar.
import { type bool, type f64, type i32, type u16, type u8, type usize } from "@tsl/core";

export function orZero(a: Uint8Array, i: usize): u8 {
  const v = a[i];
  if (v === undefined) return 0;
  return v;
}

export function present(a: Int32Array, i: usize): bool {
  return a[i] !== undefined;
}

export function sumPair(a: Uint16Array, i: usize): u16 {
  const x = a[i];
  if (x !== undefined) {
    return x;
  }
  return 65535;
}

export function floatOr(a: Float64Array, i: usize): f64 {
  const v = a[i];
  return v === undefined ? -1.5 : v;
}

export function missing(a: Int32Array, i: usize): i32 {
  const v = a[i];
  if (undefined === v) return -1;
  return v;
}
