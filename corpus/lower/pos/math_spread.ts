// Rule: Math.max(...arr.map(f)) with a known array: a loop.
// expect-no-tir: math\.
type S = { h: number };
function maxOf(a: S[]): number {
  return Math.max(...a.map((s) => s.h));
}
export function ints(a: Uint8Array): number {
  const s: S[] = [];
  for (const x of a) s.push({ h: x });
  return maxOf(s);
}
export function emptyInts(a: Uint8Array): number {
  return ints(a.subarray(0, 0));
}
export function floats(a: number[]): number {
  return Math.min(...a);
}
export function floatEmpty(a: number[]): number {
  return Math.max(...a);
}
export function plain(a: number, b: number): number[] {
  return [
    Math.max(a, b),
    Math.min(a, b),
    Math.max(a | 0, 1),
    Math.min(1, a | 0, b | 0),
    Math.max(0, -0),
  ];
}
