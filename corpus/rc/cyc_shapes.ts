// Results that hold cycles, cycles under other things, and cycles that are partly live, called repeatedly (SPEC 3.5, D41,
// D74), ported from the direct route's corpus/lower/rc/cyc_shapes.ts. Results must stay right, and what's live mustn't
// grow. TSL proper has no top-level counted object, so the long-lived self-loop is made on first use; a closure over the
// hub is an environment class; a typed array in a cycle is a tail; an array with holes is a vector of the object itself
// moved about, as a vector's elements aren't nullable.
import { toU32, u8, withTail, tail, type u32, type usize } from "@tsl/core";
import { ref, Vec } from "@tsl/std";

class Node {
  next: Node | null = null;
  other: Node | null = null;
  constructor(public v: u32) {}
}

/** `(): u32 => h.members.length + h.v`, held by `h`. */
class HubEnv {
  constructor(
    public kind: u32,
    public hub: Hub | null,
  ) {}
}

class Hub {
  members = new Vec(ref<Node>());
  cb: HubEnv | null = null;
  constructor(public v: u32) {}
}

function callHub(e: HubEnv): u32 {
  switch (e.kind) {
    case 0:
      return toU32(e.hub!.members.length) + e.hub!.v;
    default:
      return 0;
  }
}

class Shared {
  back: Shared | null = null;
  constructor(public v: u32) {}
}

class Holder {
  n: Node | null = null;
  shared: Shared | null = null;
  h: Holder | null = null;
}

class Blob {
  next: Blob | null = null;
  constructor(public v: u32) {}
  bytes = tail(u8);
}

class Sparse {
  items = new Vec(ref<Sparse>());
  constructor(public v: u32) {}
}

let kept: Node | null = null;
let live: Shared | null = null;

/** The long-lived self-loop, made the first time it's asked for. */
function theLive(): Shared {
  if (live === null) {
    live = new Shared(100);
    live.back = live;
  }
  return live!;
}

function makeCycle(v: u32): Node {
  const a = new Node(v);
  const b = new Node(v + 1);
  a.next = b;
  b.next = a;
  return a;
}

/** A result that is a two-node cycle, read through and dropped. */
export function resultInCycle(v: u32): u32 {
  const a = makeCycle(v);
  return a.next!.next!.v * 10 + a.next!.v;
}

function joins(p: Node): u32 {
  p.other = p;
  const v = p.v;
  p.other = null;
  return v;
}

/** An argument made a self-loop by its callee, then taken out again. */
export function argumentJoinsCycle(v: u32): u32 {
  const a = makeCycle(v);
  const x = joins(a);
  return x + joins(a.next!);
}

/** A hub of eight nodes holding a closure over itself. */
export function hubWithClosure(n: u32): u32 {
  const h = new Hub(n);
  for (let i: u32 = 0; i < 8; i++) h.members.push(new Node(i));
  h.cb = new HubEnv(0, h);
  return callHub(h.cb);
}

/** A dropped self-loop whose member holds a long-lived object of another type: that object stays, the loop goes. */
export function hangsFromLive(n: u32): u32 {
  const a = new Holder();
  a.shared = theLive();
  a.h = a;
  return n + a.shared.v;
}

export function liveAfter(): u32 {
  return theLive().back!.v;
}

/** Bytes in a self-loop. */
export function tailInCycle(n: u32): u32 {
  const a = withTail(32, new Blob(n));
  a.bytes[3] = 7;
  a.next = a;
  return a.bytes[3]! + a.v;
}

/** Two self-loops joined by one edge, of which only the second stays reachable. */
export function partly(n: u32): u32 {
  const a = new Node(1);
  a.next = a;
  const b = new Node(n);
  b.next = b;
  a.other = b;
  kept = b;
  return a.other.v;
}

/** An object moved about inside its own vector: inserted, shifted out, inserted again. */
export function selfMoved(n: u32): u32 {
  const s = new Sparse(n);
  const t = new Sparse(n + 1);
  s.items.push(t);
  s.items.push(t);
  s.items.push(s);
  s.items.push(t);
  s.items.removeAt(0);
  s.items.insert(1, s);
  s.items.removeAt(0);
  const len: usize = s.items.length;
  return toU32(len) * 100 + s.items.get(0).v + s.items.get(1).v;
}

export function readKept(): u32 {
  return kept === null ? 0 : kept.next!.v;
}

export function dropKept(): u32 {
  kept = null;
  return 0;
}

/** Each of the above many times over, so what's dropped is far more than what's kept. */
export function repeated(rounds: u32): u32 {
  let t: u32 = 0;
  for (let i: u32 = 0; i < rounds; i++) {
    t = (t + resultInCycle(i)) % 1_000_003;
    t = (t + argumentJoinsCycle(i)) % 1_000_003;
    t = (t + hubWithClosure(i)) % 1_000_003;
    t = (t + hangsFromLive(i)) % 1_000_003;
    t = (t + tailInCycle(i)) % 1_000_003;
    t = (t + partly(i)) % 1_000_003;
    t = (t + selfMoved(i)) % 1_000_003;
  }
  return t + liveAfter();
}
