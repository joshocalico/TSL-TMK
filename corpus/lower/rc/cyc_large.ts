// rc-stack: 65536
// Large rings and lists, dropped whole, under a small stack. What's measured is the collector's steps per allocation, and
// that everything goes without the exhaustion path (SPEC 3.5, D41). A shape a recursive scan would run off the stack with.
class Node {
  next: Node | null = null;
  constructor(public v: number) {}
}
class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: number) {}
}
class Hub {
  self: Hub | null = null;
  nodes: Zig[] = [];
}
class Zig {
  hop: Zig | null = null;
  constructor(public v: number) {}
}
class Grown {
  next: Grown | null = null;
  constructor(public v: number) {}
}
class Tick {
  constructor(public t: number) {}
}
let ringHead: Node | null = null;
let listHead: Link | null = null;
let grown: Grown | null = null;
let sink: Tick | null = null;
let zigHeld: Zig | null = null;
let plain: Tick[] = [];

export function buildRing(n: number): number {
  const first = new Node(0);
  let last = first;
  for (let i = 1; i < (n | 0); i++) {
    const r = new Node(i);
    last.next = r;
    last = r;
  }
  last.next = first;
  ringHead = first;
  return n | 0;
}
export function dropRing(): number {
  ringHead = null;
  return 0;
}
export function buildList(n: number): number {
  const head = new Link(0);
  let last = head;
  for (let i = 1; i < (n | 0); i++) {
    const c = new Link(i);
    c.prev = last;
    last.next = c;
    last = c;
  }
  listHead = head;
  return n | 0;
}
export function dropList(): number {
  listHead = null;
  return 0;
}
/** Allocation the heap grows for, in a list of its own that isn't cyclic in fact, then all dropped. */
export function growBy(n: number): number {
  let h: Grown | null = grown;
  for (let i = 0; i < (n | 0); i++) {
    const g = new Grown(i);
    g.next = h;
    h = g;
  }
  grown = h;
  return n | 0;
}
/** The same, in things that can't be in a cycle, so nothing's a candidate on the way. */
export function growPlain(n: number): number {
  for (let i = 0; i < (n | 0); i++) plain.push(new Tick(i));
  return plain.length;
}
export function dropPlain(): number {
  plain = [];
  return 0;
}
export function dropGrown(): number {
  grown = null;
  return 0;
}
export function ticks(n: number): number {
  for (let i = 0; i < (n | 0); i++) sink = new Tick(i);
  return n | 0;
}
/**
 * The worst shape there is for the marking phase: what's held reaches its way through the scan's order in alternate
 * directions, so each pass only gets one hop further. Scan order is the array's, and the hops go 0, n-1, 1, n-2, 2...
 */
export function buildZigzag(n: number): number {
  const hub = new Hub();
  hub.self = hub;
  for (let i = 0; i < (n | 0); i++) hub.nodes.push(new Zig(i));
  let lo = 0;
  let hi = (n | 0) - 1;
  let at = hub.nodes[lo]!;
  while (lo < hi) {
    const a = hub.nodes[hi]!;
    at.hop = a;
    lo++;
    const b = hub.nodes[lo]!;
    if (lo < hi) a.hop = b;
    at = b;
    hi--;
  }
  zigHeld = hub.nodes[0]!;
  return n | 0;
}
export function dropZigzagHolder(): number {
  zigHeld = null;
  return 0;
}
