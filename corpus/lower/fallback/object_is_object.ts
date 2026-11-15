// Object.is on anything but a scalar of a known type stays what it was (SPEC 4.5).
// expect-fallback: objects reflection
class P {
  x = 1;
}
export function objects(): boolean {
  const a = new P();
  return Object.is(a, a);
}
