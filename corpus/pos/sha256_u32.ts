import { toU32, type u32, type usize } from "@tsl/core";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);
const H = new Uint32Array(8);
const BLOCK = new Uint8Array(64);

function rotr(x: u32, n: u32): u32 {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function compress(): void {
  for (let t: usize = 0; t < 16; t++) {
    const at = t * 4;
    W[t] =
      ((BLOCK[at]! << 24) | (BLOCK[at + 1]! << 16) | (BLOCK[at + 2]! << 8) | BLOCK[at + 3]!) >>> 0;
  }
  for (let t: usize = 16; t < 64; t++) {
    const w15 = W[t - 15]!;
    const w2 = W[t - 2]!;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
  }
  let a = H[0]!;
  let b = H[1]!;
  let c = H[2]!;
  let d = H[3]!;
  let e = H[4]!;
  let f = H[5]!;
  let g = H[6]!;
  let h = H[7]!;
  for (let t: usize = 0; t < 64; t++) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + s1 + ch + K[t]! + W[t]!) >>> 0;
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  H[0] = (H[0]! + a) >>> 0;
  H[1] = (H[1]! + b) >>> 0;
  H[2] = (H[2]! + c) >>> 0;
  H[3] = (H[3]! + d) >>> 0;
  H[4] = (H[4]! + e) >>> 0;
  H[5] = (H[5]! + f) >>> 0;
  H[6] = (H[6]! + g) >>> 0;
  H[7] = (H[7]! + h) >>> 0;
}

/** Hashes `msg` and writes the 32-byte digest to `out`. */
export function sha256(msg: Uint8Array, out: Uint8Array): void {
  H[0] = 0x6a09e667;
  H[1] = 0xbb67ae85;
  H[2] = 0x3c6ef372;
  H[3] = 0xa54ff53a;
  H[4] = 0x510e527f;
  H[5] = 0x9b05688c;
  H[6] = 0x1f83d9ab;
  H[7] = 0x5be0cd19;
  let filled: usize = 0;
  for (let i: usize = 0; i < msg.length; i++) {
    BLOCK[filled] = msg[i]!;
    filled++;
    if (filled === 64) {
      compress();
      filled = 0;
    }
  }
  BLOCK[filled] = 0x80;
  filled++;
  if (filled > 56) {
    while (filled < 64) {
      BLOCK[filled] = 0;
      filled++;
    }
    compress();
    filled = 0;
  }
  while (filled < 56) {
    BLOCK[filled] = 0;
    filled++;
  }
  const bits = toU32(msg.length * 8);
  BLOCK[56] = 0;
  BLOCK[57] = 0;
  BLOCK[58] = 0;
  BLOCK[59] = 0;
  BLOCK[60] = bits >>> 24;
  BLOCK[61] = (bits >>> 16) & 0xff;
  BLOCK[62] = (bits >>> 8) & 0xff;
  BLOCK[63] = bits & 0xff;
  compress();
  for (let i: usize = 0; i < 8; i++) {
    const word = H[i]!;
    out[i * 4] = word >>> 24;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
}
