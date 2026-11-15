// Bit operations keep the low bits of an exact value: wrap where that's exact, else f64 as JS does.
// expect-tir: js\.toint32|lshr\.js32
function hashStep(h: number, c: number): number {
  return (h * 33 + c) >>> 0;
}
export function hash(a: Uint8Array): number {
  let h = 5381;
  for (let i = 0; i < a.length; i++) h = hashStep(h, a[i]!);
  return h;
}
function hugeProduct(a: number, b: number): number {
  return (a * b) | 0;
}
export function huge(a: number, b: number): number {
  return hugeProduct(a | 0, b | 0);
}
function wrapAdd(a: number, b: number, c: number): number {
  return (a + b + c) | 0;
}
export function adds(a: number, b: number, c: number): number {
  return wrapAdd(a | 0, b | 0, c | 0);
}
function acc(a: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < a.length; i++) v = ((v << 8) | a[i]!) >>> 0;
  return v;
}
export function accumulate(a: Uint8Array): number {
  return acc(a) >>> 4;
}
export function shiftCounts(a: number, n: number): number[] {
  return [(a | 0) << (n | 0), (a | 0) >> (n | 0), (a | 0) >>> (n | 0)];
}
export function u32Compare(a: Uint32Array): number[] {
  return [a[0]! > a[1]! ? 1 : 0, a[0]! + a[1]!, a[0]! - a[1]!, a[0]! % 7];
}
export function mixed(a: number, flag: boolean): number {
  let x = 0;
  x = flag ? a >>> 0 : a | 0;
  return x + 1;
}
