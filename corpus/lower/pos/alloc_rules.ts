// Rules: non-escaping allocation on the stack; escaping within an export call in the arena, copied out.
// expect-note: alloc-stack
// expect-note: alloc-arena
// expect-tir: alloca
class Acc {
  sum = 0;
  add(x: number): void {
    this.sum += x;
  }
}
function fillIn(t: Int32Array): void {
  for (let i = 0; i < t.length; i++) t[i] = i * i;
}
export function onStack(n: number): number {
  const a = new Acc();
  a.add(n | 0);
  a.add(2);
  const t = new Int32Array(16);
  fillIn(t);
  return a.sum + t[3]!;
}
function deep(n: number): number {
  const t = new Int32Array(4);
  t[0] = n;
  return n <= 0 ? 0 : t[0]! + deep(n - 1);
}
export function recursion(n: number): number {
  return deep(n | 0);
}
function build(n: number): Uint16Array {
  const t = new Uint16Array(n);
  for (let i = 0; i < n; i++) t[i] = i * 3;
  return t;
}
export function escapes(n: number): Uint16Array {
  return build(n | 0);
}
export function nested(n: number): { a: Uint16Array; b: { c: number[] } } {
  return { a: build(n | 0), b: { c: [n | 0, 2, 3] } };
}
export function twoCalls(n: number): number {
  return escapes(n)[1]! + escapes(n)[2]!;
}
