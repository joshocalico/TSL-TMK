// Rule: map, filter, reduce, find, forEach, Array.from({length}, fn), for...of: loops, closure inlined.
// expect-no-tir: call\.indirect
type P = { n: number; w: number };
export function mapFilter(a: number[]): number[] {
  return a.map((x) => x * 2).filter((x) => x > 2);
}
export function reduced(a: number[]): number {
  return a.reduce((s, x) => s + x, 10);
}
export function reducedNoInit(a: number[]): number {
  return a.reduce((s, x) => s * x);
}
export function typedReduce(a: Uint8Array): number {
  return a.reduce((s, x) => s + x, 0);
}
export function finder(a: P[], k: number): number {
  const hit = a.find((p) => p.n === k);
  return hit === undefined ? -1 : hit.w;
}
export function forEachIdx(a: Int16Array): number {
  let s = 0;
  a.forEach((v, i) => {
    s += v * i;
  });
  return s;
}
export function fromLength(n: number): number[] {
  return Array.from({ length: n | 0 }, (_, i) => i * i);
}
export function fromCapture(n: number): P[] {
  const k = 3;
  return Array.from({ length: n | 0 }, (_, i) => ({ n: i, w: i * k }));
}
export function ofArray(a: number[]): number {
  let s = 0;
  for (const x of a) s += x;
  return s;
}
export function ofTyped(a: Uint8Array): number {
  let s = 0;
  for (const x of a) {
    if (x === 0) continue;
    if (x === 9) break;
    s += x;
  }
  return s;
}
export function someEvery(a: number[]): number[] {
  return [
    a.some((x) => x > 2) ? 1 : 0,
    a.every((x) => x > 0) ? 1 : 0,
    a.findIndex((x) => x === 2),
    a.indexOf(3),
    a.includes(4) ? 1 : 0,
  ];
}
export function typedMap(a: Uint8Array): Uint8Array {
  return a.map((x) => x + 250);
}
export function nanIncludes(a: Float64Array, x: number): boolean {
  return a.includes(x);
}
export function sliced(a: number[], s: number, e: number): number[] {
  return a.slice(s, e);
}
