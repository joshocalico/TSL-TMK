import {
  toF64,
  toI32,
  toU32,
  wrapI16,
  wrapI32,
  wrapI8,
  wrapU16,
  wrapU32,
  wrapU8,
  type f64,
  type i16,
  type i32,
  type i8,
  type u16,
  type u32,
  type u64,
  type u8,
} from "@tsl/core";

export function toInt32(x: f64): i32 {
  return x | 0;
}
export function toUint32(x: f64): u32 {
  return x >>> 0;
}
export function shifted(x: f64): i32 {
  return x << 1;
}
export function notFloat(x: f64): i32 {
  return ~x;
}
export function wrapByte(x: f64): u8 {
  return wrapU8(x);
}
export function wrapSigned(x: f64): i8 {
  return wrapI8(x);
}
export function wrapBig16(x: u64): u16 {
  return wrapU16(x);
}
export function wrapBigI16(x: u64): i16 {
  return wrapI16(x);
}
export function wrapBig32(x: u64): u32 {
  return wrapU32(x);
}
export function wrapBigI32(x: u64): i32 {
  return wrapI32(x);
}
export function checkedFromFloat(x: f64): i32 {
  return toI32(x);
}
export function checkedU32FromFloat(x: f64): u32 {
  return toU32(x);
}
export function intZeroToFloat(a: i32): f64 {
  // On V8, 0 * -1 is -0 even though both are integers. toF64 has to make that +0 on every engine,
  // or dividing by the result would tell the two apart.
  const product: i32 = a * -1;
  return 1 / toF64(product);
}
export function remZeroToFloat(a: i32, b: i32): f64 {
  const r: i32 = a % b;
  return 1 / toF64(r);
}
