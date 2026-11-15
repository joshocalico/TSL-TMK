// A churn program under `rc`: n small objects allocated in total, with at most 64 alive, and a short array and a closure
// per 16 objects. Under `leak` it keeps everything. V8 has its collector. bench/memory/list.c has the same by hand in C.
class Node {
  next: Node | null = null;
  constructor(public value: number) {}
}

let window: Node | null = null;

export function churnWork(n: number): number {
  let t = 0;
  let live = 0;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = window;
    window = c;
    live++;
    if (live === 64) {
      window = null;
      live = 0;
    }
    t = (t + c.value) | 0;
  }
  return t | 0;
}
