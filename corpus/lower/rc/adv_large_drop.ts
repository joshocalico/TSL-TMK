// rc-stack: 65536
// A million-node list and a very large array of references, dropped under a 64 KiB stack. A recursive free would run
// off it: the runtime's guard page turns that into a fatal exception, not a wrong answer.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
let head: Node | null = null;
let many: Node[] = [];

export function buildList(n: number): number {
  let h: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  head = h;
  return n | 0;
}
export function dropList(): number {
  head = null;
  return 0;
}
export function buildMany(n: number): number {
  const a: Node[] = [];
  for (let i = 0; i < (n | 0); i++) a.push(new Node(i));
  many = a;
  return a.length;
}
export function dropMany(): number {
  many = [];
  return 0;
}
export function allocAfter(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) t = (t + new Node(i).v) | 0;
  return t;
}
export function sumList(): number {
  let t = 0;
  for (let c = head; c !== null; c = c.next) t = (t + c.v) | 0;
  return t;
}
