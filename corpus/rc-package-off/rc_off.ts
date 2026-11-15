// A package that asks for `rc` with the cycle collector off (SPEC 9.2, D41), in a type that could use it.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
export function make(v: number): number {
  const n = new Node(v);
  n.next = n;
  return n.next.v;
}
