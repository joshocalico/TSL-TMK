// expect-fallback: dynamic computed-key
// expect-fallback: record computed-key
export function dynamic(o: { a: number; b: number }, k: "a" | "b"): number {
  return o[k];
}
export function record(n: number): number {
  const r: Record<string, number> = {};
  r["k"] = n;
  return r["k"]!;
}
