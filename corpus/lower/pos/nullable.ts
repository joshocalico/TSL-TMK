// Rule: T | null on heap objects is a null pointer; on scalars a tag.
// expect-tir: load\.ptr
type Node = { value: number; next: Node | null };
type Opt = { a?: number; b?: Uint8Array; c: number | null };
function listSum(n: Node | null): number {
  let sum = 0;
  for (let cur = n; cur !== null; cur = cur.next) sum += cur.value;
  return sum;
}
export function list(k: number): number {
  let head: Node | null = null;
  for (let i = 0; i < (k | 0); i++) head = { value: i, next: head };
  return listSum(head);
}
function maybe(x: number): number | null {
  return x > 0 ? x * 2 : null;
}
export function scalar(x: number): number {
  const m = maybe(x);
  if (m === null) return -1;
  return m + 1;
}
export function coalesce(x: number): number {
  return (maybe(x) ?? 7) + (x > 5 ? (maybe(x) ?? 0) : 0);
}
export function byteOr(b: Uint8Array, i: number): number {
  const v = b[i | 0];
  return v === undefined ? -1 : v;
}
export function byteIs(b: Uint8Array, i: number): boolean {
  const next = b[i | 0];
  return next === 0;
}
export function optional(o: Opt): number {
  const a = o.a ?? 10;
  const len = o.b?.length ?? 20;
  const c = o.c ?? 30;
  return a + len + c;
}
export function truthiness(x: number): number {
  const m = maybe(x);
  return m ? 1 : 0;
}
export function chain(k: number): number {
  const n: Node = { value: 1, next: k > 0 ? { value: 2, next: null } : null };
  return n.next?.value ?? 100;
}
export function bang(k: number): number {
  const n: Node = { value: 1, next: k > 0 ? { value: 2, next: null } : null };
  return n.next!.value;
}
