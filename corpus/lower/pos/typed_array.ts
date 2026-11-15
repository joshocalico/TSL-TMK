// Rule: typed array is (ptr, len); .subarray is pointer arithmetic with JS clamping; stores convert as JS.
// expect-tir: fdemote
export function sub(a: Uint8Array, from: number, to: number): number[] {
  const s = a.subarray(from, to);
  return [s.length, s[0] ?? -1];
}
export function subWrites(a: Uint8Array): void {
  const s = a.subarray(1, 3);
  s[0] = 99;
  s[5] = 77;
}
export function subReturn(a: Uint8Array): Uint8Array {
  return a.subarray(1);
}
export function mod256(v: number): Uint8Array {
  const t = new Uint8Array(1);
  t[0] = v;
  return t;
}
export function int16(v: number): Int16Array {
  const t = new Int16Array(1);
  t[0] = v;
  return t;
}
export function int32(v: number): Int32Array {
  const t = new Int32Array(1);
  t[0] = v;
  return t;
}
export function round32(v: number): Float32Array {
  const t = new Float32Array(1);
  t[0] = v;
  return t;
}
export function readBang(a: Uint8Array, i: number): number {
  return a[i | 0]!;
}
export function readPlain(a: Uint8Array, i: number): number | undefined {
  return a[i | 0];
}
export function fractionalIndex(a: Uint8Array, i: number): number | undefined {
  return a[i];
}
export function writeOutOfBounds(a: Uint8Array, i: number): number {
  a[i | 0] = 7;
  return a.length;
}
export function compoundIndex(a: Int16Array): void {
  a[0]! |= 1 << 3;
  a[1]! += 1000;
  a[2]!++;
}
export function chained(a: Uint8Array): void {
  a[0] = a[1] = a[2] = 300;
}
export function fillSetSlice(n: number): number[] {
  const t = new Int32Array(6).fill(-1);
  t.fill(5, 1, 3);
  const u = new Int32Array(2);
  u[0] = 8;
  u[1] = 9;
  t.set(u, 4);
  const v = t.slice(1, 5);
  return [v.length, v[0]!, v[3]!, t[4]!, n];
}
export function copied(a: Uint8Array): Uint16Array {
  return new Uint16Array(a);
}
export function literal(): Float64Array {
  return new Float64Array([1.5, 2.5]);
}
export function float32Math(a: Float32Array): number {
  const x = a[0]! + a[1]!;
  return x;
}
