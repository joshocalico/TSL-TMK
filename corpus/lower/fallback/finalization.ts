// expect-fallback: finalizes finalization
// A finalizer needs something that runs callbacks when a free happens. Nothing does, in any mode.
export function finalizes(n: number): number {
  const r = new FinalizationRegistry<number>(() => undefined);
  r.register({ a: 1 }, n | 0);
  return n | 0;
}
