// expect-fallback: later async
// expect-fallback: gen generator
export async function later(a: number): Promise<number> {
  return a + 1;
}
export function* gen(): Generator<number> {
  yield 1;
}
