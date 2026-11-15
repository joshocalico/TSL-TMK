// A typed array is a pointer and a length: it has no one reference for a WeakRef to hold.
export function weakBytes(n: number): number {
  const b = new Uint8Array(n | 0);
  const r = new WeakRef(b);
  return r.deref() === undefined ? -1 : b.length;
}
