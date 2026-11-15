// expect-fallback: withMap map-set
// expect-fallback: withSet map-set
export function withMap(a: number): number {
  const m = new Map<number, number>();
  m.set(1, a);
  return m.get(1)!;
}
export function withSet(a: number): number {
  return new Set([a, a]).size;
}
