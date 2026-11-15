// Results that hold cycles, cycles under other things, and cycles that are partly live, called repeatedly: results must stay
// right, and with results and arguments released, what's live mustn't grow (SPEC 3.5, D41).
class Node {
  next: Node | null = null;
  other: Node | null = null;
  bytes: Uint8Array | null = null;
  constructor(public v: number) {}
}
class Hub {
  members: Node[] = [];
  cb: (() => number) | null = null;
  constructor(public v: number) {}
}
class Shared {
  back: Shared | null = null;
  constructor(public v: number) {}
}
class Holder {
  n: Node | null = null;
  shared: Shared | null = null;
  h: Holder | null = null;
}
let kept: Node | null = null;
const live = new Shared(100);
live.back = live;

export function resultInCycle(v: number): Node {
  const a = new Node(v);
  const b = new Node(v + 1);
  a.next = b;
  b.next = a;
  return a;
}
export function argumentJoinsCycle(p: Node): number {
  p.other = p;
  const v = p.v;
  p.other = null;
  return v;
}
export function hubWithClosure(n: number): number {
  const h = new Hub(n | 0);
  for (let i = 0; i < 8; i++) h.members.push(new Node(i));
  h.cb = (): number => h.members.length + h.v;
  return h.cb();
}
export function hangsFromLive(n: number): number {
  // A dropped ring whose members hold a long-lived object of another type: that object stays, the ring goes.
  const a = new Holder();
  a.shared = live;
  a.h = a;
  return (n | 0) + live.v;
}
export function liveAfter(): number {
  return live.back!.v;
}
export function typedArrayInCycle(n: number): number {
  const a = new Node(n | 0);
  a.bytes = new Uint8Array(32);
  a.bytes[3] = 7;
  a.next = a;
  return a.bytes[3]! + a.v;
}
export function partly(n: number): number {
  // Two rings joined by one edge, of which only the second stays reachable.
  const a = new Node(1);
  a.next = a;
  const b = new Node(n | 0);
  b.next = b;
  a.other = b;
  kept = b;
  return a.other.v;
}
class Sparse {
  items: (Sparse | null)[] = [null, null, null, null];
  constructor(public v: number) {}
}
export function holesMoved(n: number): number {
  // Moving a slot that holds nothing, in an array whose elements can be in a cycle.
  const s = new Sparse(n | 0);
  s.items[2] = s;
  s.items.shift();
  s.items.splice(1, 0, null);
  s.items.shift();
  return s.items.length + s.v;
}
export function readKept(): number {
  return kept === null ? -1 : kept.next!.v;
}
export function dropKept(): number {
  kept = null;
  return 0;
}
