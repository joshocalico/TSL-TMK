// Large rings and lists, dropped whole, and the zigzag, the marking phase's worst shape (SPEC 3.5, D41, D74), ported at
// moderate sizes from the direct route's corpus/lower/rc/cyc_large.ts. A shape a recursive scan would run off the stack
// with. A vector of counted references can't be a global in TSL proper, so the plain objects are in a holder's vector.
import { toU32, type u32, type usize } from "@tsl/core";
import { ref, Vec } from "@tsl/std";

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}
}

class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: u32) {}
}

class Hub {
  self: Hub | null = null;
  nodes = new Vec(ref<Zig>());
}

class Zig {
  hop: Zig | null = null;
  constructor(public v: u32) {}
}

class Grown {
  next: Grown | null = null;
  constructor(public v: u32) {}
}

class Tick {
  constructor(public t: u32) {}
}

class Plain {
  items = new Vec(ref<Tick>());
}

let ringHead: Node | null = null;
let _listHead: Link | null = null;
let grown: Grown | null = null;
let _sink: Tick | null = null;
let zigHeld: Zig | null = null;
let plain: Plain | null = null;

export function buildRing(n: u32): u32 {
  const first = new Node(0);
  let last = first;
  for (let i: u32 = 1; i < n; i++) {
    const r = new Node(i);
    last.next = r;
    last = r;
  }
  last.next = first;
  ringHead = first;
  return n;
}

export function readRing(): u32 {
  let t: u32 = 0;
  let p = ringHead;
  for (let i: u32 = 0; i < 10 && p !== null; i++) {
    t = t * 3 + p.v;
    p = p.next;
  }
  return t;
}

export function dropRing(): u32 {
  ringHead = null;
  return 0;
}

export function buildList(n: u32): u32 {
  const head = new Link(0);
  let last = head;
  for (let i: u32 = 1; i < n; i++) {
    const c = new Link(i);
    c.prev = last;
    last.next = c;
    last = c;
  }
  _listHead = head;
  return n;
}

export function dropList(): u32 {
  _listHead = null;
  return 0;
}

/** Allocation the heap grows for, in a list of its own that isn't cyclic in fact, then all dropped. */
export function growBy(n: u32): u32 {
  let h: Grown | null = grown;
  for (let i: u32 = 0; i < n; i++) {
    const g = new Grown(i);
    g.next = h;
    h = g;
  }
  grown = h;
  return n;
}

export function dropGrown(): u32 {
  grown = null;
  return 0;
}

/** The same, in things that can't be in a cycle, so nothing's a candidate on the way. */
export function growPlain(n: u32): u32 {
  if (plain === null) plain = new Plain();
  const p = plain!;
  for (let i: u32 = 0; i < n; i++) p.items.push(new Tick(i));
  return toU32(p.items.length);
}

export function dropPlain(): u32 {
  plain = null;
  return 0;
}

export function ticks(n: u32): u32 {
  for (let i: u32 = 0; i < n; i++) _sink = new Tick(i);
  return n;
}

/**
 * The worst shape there is for the marking phase: what's held reaches its way through the scan's order in alternate
 * directions, so each pass only gets one hop further. Scan order is the vector's, and the hops go 0, n-1, 1, n-2, 2...
 * The hub is a self-loop holding the vector, garbage once this returns; the nodes stay, held from `zigHeld`.
 */
export function buildZigzag(n: u32): u32 {
  const hub = new Hub();
  hub.self = hub;
  for (let i: u32 = 0; i < n; i++) hub.nodes.push(new Zig(i));
  let lo: usize = 0;
  let hi: usize = hub.nodes.length - 1;
  let at = hub.nodes.get(lo);
  while (lo < hi) {
    const a = hub.nodes.get(hi);
    at.hop = a;
    lo++;
    const b = hub.nodes.get(lo);
    if (lo < hi) a.hop = b;
    at = b;
    hi--;
  }
  zigHeld = hub.nodes.get(0);
  return n;
}

/** The zigzag's chain from its holder: every node, in hop order. */
export function readZigzag(): u32 {
  let t: u32 = 0;
  let c: u32 = 0;
  for (let p = zigHeld; p !== null; p = p.hop) {
    t = (t * 7 + p.v) % 1_000_003;
    c++;
  }
  return c * 1_000_000 + t;
}

export function dropZigzagHolder(): u32 {
  zigHeld = null;
  return 0;
}
