// A list-heavy ordinary-TS program that lowers with `--memory leak` (SPEC 4.5): every node truly escapes, through a
// global. Nothing's ever freed natively, and V8 has its collector.
class Node {
  next: Node | null = null;
  constructor(public value: number) {}
}

let head: Node | null = null;

export function listWork(n: number): number {
  let h: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  head = h;
  let t = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = head; c !== null; c = c.next) t = (t + c.value) | 0;
  }
  return t | 0;
}
