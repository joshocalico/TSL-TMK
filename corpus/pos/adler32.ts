import { type u32, type usize } from "@tsl/core";

const MOD: u32 = 65521;

export function adler32(data: Uint8Array): u32 {
  let a: u32 = 1;
  let b: u32 = 0;
  for (let i: usize = 0; i < data.length; i++) {
    a = (a + data[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}
