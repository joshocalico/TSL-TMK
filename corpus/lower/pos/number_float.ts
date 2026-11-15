// Rule: number with fractional sources is f64; integer-only again after floor, ceil, round, |0, >>>0.
// expect-tir: fdiv\.f64
// expect-tir: ffloor\.f64
function half(x: number): number {
  return x / 2;
}
function intAgain(x: number): number {
  const f = half(x);
  const i = Math.floor(f);
  return i + 1;
}
export function frac(x: number): number {
  return half(x | 0) + 0.25;
}
export function floorAgain(x: number): number {
  return intAgain(x | 0);
}
export function ceilAgain(x: number): number {
  const c = Math.ceil((x | 0) / 3);
  return c * 2;
}
export function roundAgain(x: number): number {
  return Math.round(x);
}
export function orZero(x: number): number {
  return ((x * 1.5) | 0) + 1;
}
export function shiftZero(x: number): number {
  return (x * -1.5) >>> 0;
}
export function floatEvidence(n: number): number {
  let v = 0;
  for (let i = 0; i < (n | 0); i++) v = v + 0.5;
  return v;
}
export function negZeroThroughCeil(x: number): number {
  return 1 / Math.ceil(x);
}
export function floorHuge(x: number): number {
  return Math.floor(x * 1e10) + 1;
}
export function nanFlows(x: number): number {
  const y = x / 0;
  return y !== y ? 1 : 2;
}
