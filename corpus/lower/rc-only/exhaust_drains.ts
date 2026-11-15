// memory-pages: 300
// A pending free is drained before exhaustion is reported: trap 14 only if memory is still short after that.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
let head: Node | null = null;
let big: Float64Array | null = null;
export function build(n: number): number {
  let h: Node | null = null;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = h;
    h = c;
  }
  head = h;
  return n | 0;
}
export function dropAndAllocate(n: number): number {
  head = null;
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = head;
    head = c;
    t = (t + c.v) | 0;
  }
  return t;
}
export function largeRunsAreReused(rounds: number): number {
  // 16 pages each time, far more in total than the limit: a dropped run comes back when one its size is wanted.
  let t = 0;
  for (let i = 0; i < (rounds | 0); i++) {
    big = new Float64Array(8000);
    big[i] = 1;
    t = (t + big[i]!) | 0;
    big = null;
  }
  return t;
}
let more: Node | null = null;
export function smallFromLargeRun(n: number): number {
  // What's left at the source runs out partway, and the 16 pages of the dropped run are still free: small blocks are cut
  // from it, after a drain, rather than trapping.
  let k = 0;
  for (let i = 0; i < (n | 0); i++) {
    const c = new Node(i);
    c.next = more;
    more = c;
    k++;
  }
  return k;
}
export function reallyOut(n: number): number {
  head = null;
  more = null;
  const keep: Node[] = [];
  for (let i = 0; i < (n | 0); i++) keep.push(new Node(i));
  return keep.length;
}
export function stillAlive(): number {
  return new Node(5).v;
}
