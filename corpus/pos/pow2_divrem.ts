import { idiv, type u32, type u64 } from "@tsl/core";

// R1f: an unsigned remainder or division by a power of two is an `and` or a shift once optimised, and by anything else
// stays a division; each answer the same as JS's.
export function rem8(a: u32): u32 {
  return a % 8;
}
export function rem2p24(a: u32): u32 {
  return a % 0x100_0000;
}
export function rem2p31(a: u32): u32 {
  return a % 0x8000_0000;
}
export function rem1(a: u32): u32 {
  return a % 1;
}
export function rem10(a: u32): u32 {
  return a % 10;
}
export function div16(a: u32): u32 {
  return idiv(a, 16);
}
export function div2p31(a: u32): u32 {
  return idiv(a, 0x8000_0000);
}
export function rem64k(a: u64): u64 {
  return a % 0x1_0000n;
}
export function rem2p63(a: u64): u64 {
  return a % 0x8000_0000_0000_0000n;
}
export function div2p32(a: u64): u64 {
  return a / 0x1_0000_0000n;
}
export function div2p63(a: u64): u64 {
  return a / 0x8000_0000_0000_0000n;
}
