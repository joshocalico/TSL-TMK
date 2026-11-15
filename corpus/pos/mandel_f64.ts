import { toF64, type f64, type u32 } from "@tsl/core";

export function escape(cr: f64, ci: f64, limit: u32): u32 {
  let zr: f64 = 0;
  let zi: f64 = 0;
  for (let n: u32 = 0; n < limit; n++) {
    const zr2 = zr * zr;
    const zi2 = zi * zi;
    if (zr2 + zi2 > 4) return n;
    zi = 2 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
  }
  return limit;
}

export function checksum(width: u32, height: u32, limit: u32): u32 {
  let sum: u32 = 0;
  for (let y: u32 = 0; y < height; y++) {
    for (let x: u32 = 0; x < width; x++) {
      const cr = -2 + (3 * toF64(x)) / toF64(width);
      const ci = -1 + (2 * toF64(y)) / toF64(height);
      sum = ((Math.imul(sum, 31) >>> 0) + escape(cr, ci, limit)) >>> 0;
    }
  }
  return sum;
}
