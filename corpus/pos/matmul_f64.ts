import { type f64, type usize } from "@tsl/core";

/** out = a * b, all n-by-n, row-major. */
export function matmul(a: Float64Array, b: Float64Array, out: Float64Array, n: usize): void {
  for (let i: usize = 0; i < n; i++) {
    for (let j: usize = 0; j < n; j++) {
      let sum: f64 = 0;
      for (let k: usize = 0; k < n; k++) {
        sum += a[i * n + k]! * b[k * n + j]!;
      }
      out[i * n + j] = sum;
    }
  }
}

export function trace(m: Float64Array, n: usize): f64 {
  let t: f64 = 0;
  for (let i: usize = 0; i < n; i++) t += m[i * n + i]!;
  return t;
}

export function scale(m: Float64Array, k: f64): void {
  for (let i: usize = 0; i < m.length; i++) {
    m[i]! *= k;
  }
}
