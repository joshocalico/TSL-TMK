// The native libm against V8, on many values. Native only: V8 and JSC themselves differ in the last
// bit on these functions (SPEC 3.10, divergence 7), so this can't be in the two-engine corpus.
export function sin1(x: number): number {
  return Math.sin(x);
}
export function cos1(x: number): number {
  return Math.cos(x);
}
export function exp1(x: number): number {
  return Math.exp(x);
}
export function log1(x: number): number {
  return Math.log(x);
}
export function atan2v(a: number, b: number): number {
  return Math.atan2(a, b);
}
export function powv(a: number, b: number): number {
  return Math.pow(a, b);
}
