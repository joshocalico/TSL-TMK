// expect-fallback: matches regexp
// expect-fallback: stamp date
export function matches(a: number): boolean {
  return /x/.test(a > 0 ? "x" : "y");
}
export function stamp(): boolean {
  return new Date(0).getTime() === 0;
}
