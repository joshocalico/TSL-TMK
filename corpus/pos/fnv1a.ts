import { toU64, type u32, type u64, type usize } from "@tsl/core";

export function fnv32(data: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: usize = 0; i < data.length; i++) {
    h = Math.imul((h ^ data[i]!) >>> 0, 0x01000193) >>> 0;
  }
  return h;
}

export function fnv64(data: Uint8Array): u64 {
  let h: u64 = 0xcbf29ce484222325n;
  for (const b of data) {
    h = BigInt.asUintN(64, (h ^ toU64(b)) * 0x100000001b3n);
  }
  return h;
}
