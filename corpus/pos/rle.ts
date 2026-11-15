import { trap, toU8, type u8, type usize } from "@tsl/core";

/** Encodes as (count, byte) pairs, and returns the length written. Traps if `out` is too small. */
export function encode(input: Uint8Array, out: Uint8Array): usize {
  let w: usize = 0;
  let i: usize = 0;
  while (i < input.length) {
    const b = input[i]!;
    let run: usize = 1;
    while (i + run < input.length && input[i + run]! === b && run < 255) run++;
    if (w + 2 > out.length) trap(Code.OutTooSmall);
    out[w] = toU8(run);
    out[w + 1] = b;
    w += 2;
    i += run;
  }
  return w;
}

export function decode(input: Uint8Array, out: Uint8Array): usize {
  let w: usize = 0;
  for (let i: usize = 0; i + 1 < input.length; i += 2) {
    const run: u8 = input[i]!;
    const b = input[i + 1]!;
    for (let k: u8 = 0; k < run; k++) {
      out[w] = b;
      w++;
    }
  }
  return w;
}

/** This program's own trap code (3.10: from 1000, named). */
enum Code {
  OutTooSmall = 1000,
}
