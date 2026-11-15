// expect-fallback: viaAny any-type
// expect-lowered: clean
export function viaAny(x: any): number {
  return x.y + 1;
}
export function clean(a: number): number {
  return a + 1;
}
