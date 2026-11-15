import { type i32, type u16, type u32, type u8 } from "@tsl/core";

export function addWrapI32(a: i32, b: i32): i32 {
  return (a + b) | 0;
}
export function addWrapU32(a: u32, b: u32): u32 {
  return (a + b) >>> 0;
}
export function subWrapU32(a: u32, b: u32): u32 {
  return (a - b) >>> 0;
}
export function chainWrap(a: u32, b: u32, c: u32, d: u32): u32 {
  return (a + b - c + d) >>> 0;
}
export function maskU8(a: u8, b: u8): u8 {
  return (a + b) & 0xff;
}
export function maskSub(a: u8, b: u8): u8 {
  return (a - b) & 0xff;
}
export function mul16(a: u16, b: u16): i32 {
  return (a * b) | 0;
}
export function mul16Mask(a: u16, b: u16): u16 {
  return (a * b) & 0xffff;
}
export function imul(a: i32, b: i32): i32 {
  return Math.imul(a, b);
}
export function imulU32(a: u32, b: u32): u32 {
  return Math.imul(a, b) >>> 0;
}
