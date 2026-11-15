import { lit, type u32, type usize } from "@tsl/core";

const ALPHABET = lit("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const PAD = 61; // "="

function sextet(word: u32, shift: u32): usize {
  return (word >>> shift) & 63;
}

/** Writes base64 into `out`, and returns the length written. */
export function encode(input: Uint8Array, out: Uint8Array): usize {
  let r: usize = 0;
  let w: usize = 0;
  while (r + 3 <= input.length) {
    const word = ((input[r]! << 16) | (input[r + 1]! << 8) | input[r + 2]!) >>> 0;
    out[w] = ALPHABET[sextet(word, 18)]!;
    out[w + 1] = ALPHABET[sextet(word, 12)]!;
    out[w + 2] = ALPHABET[sextet(word, 6)]!;
    out[w + 3] = ALPHABET[sextet(word, 0)]!;
    r += 3;
    w += 4;
  }
  const left = input.length - r;
  if (left === 1) {
    const word = (input[r]! << 16) >>> 0;
    out[w] = ALPHABET[sextet(word, 18)]!;
    out[w + 1] = ALPHABET[sextet(word, 12)]!;
    out[w + 2] = PAD;
    out[w + 3] = PAD;
    w += 4;
  } else if (left === 2) {
    const word = ((input[r]! << 16) | (input[r + 1]! << 8)) >>> 0;
    out[w] = ALPHABET[sextet(word, 18)]!;
    out[w + 1] = ALPHABET[sextet(word, 12)]!;
    out[w + 2] = ALPHABET[sextet(word, 6)]!;
    out[w + 3] = PAD;
    w += 4;
  }
  return w;
}
