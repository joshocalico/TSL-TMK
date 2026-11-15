// expect-fallback: guarded try-catch
// expect-lowered: thrower
export function thrower(a: number): number {
  if (a > 0) throw new Error("positive");
  return a;
}
export function guarded(a: number): number {
  try {
    return thrower(a);
  } catch {
    return -1;
  }
}
