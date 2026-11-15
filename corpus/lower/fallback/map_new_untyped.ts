// `new Map()` with nothing to say what it holds: in strict its root cause is map-set, and in a memory mode any-type (SPEC 4.5).
// expect-fallback: nowhere map-set
export function nowhere(): number {
  const m = new Map();
  m.set(1, 2);
  return m.size;
}
