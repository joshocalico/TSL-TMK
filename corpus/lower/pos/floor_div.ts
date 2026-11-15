// Rule: Math.floor(a / b) on ints: float then floor, unless proved non-negative i32, then integer.
// expect-tir: sdiv\.i32
// expect-tir: ffloor\.f64
function provedNonNeg(a: Uint8Array, k: number): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.floor(a[i]! / k);
  return total;
}
function maybeNeg(a: number, b: number): number {
  return Math.floor(a / b);
}
export function proved(a: Uint8Array): number {
  return provedNonNeg(a, 16);
}
export function signed(a: number, b: number): number {
  return maybeNeg(a | 0, b | 0);
}
export function divZero(a: Uint8Array): number {
  return provedNonNeg(a, 0);
}
export function flooredByField(a: Uint8Array): number {
  const o = { k: a.length, n: 3 };
  return Math.floor(o.k / o.n) + Math.floor((o.k * 7) / o.n);
}
