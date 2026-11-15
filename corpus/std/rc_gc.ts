// @tsl/gc's Rc as a library any package can use (SPEC 3.5, D63): counts, sharing, moving a count into a field, replacing,
// bounded freeing, no leaks, and the generation on every counted reference making a stale copy trap 5. The same program
// on V8, JSC and natively. The negative tests for moves are corpus/neg/rc_use_after_drop.ts and rc_use_after_take.ts.
import { toU32, type bool, type u32, type usize } from "@tsl/core";
import { Rc, Visit, type Counted } from "@tsl/gc";

class Node {
  next: Counted<Node> | null = null;
  constructor(public v: u32) {}
}

class Holder {
  child: Counted<Node> | null = null;
  constructor(public id: u32) {}
}

/** A Node's one reference slot, `next`, released (3.5's release functions). */
function releaseNode(n: Node, at: usize, op: Visit): usize {
  const next = n.next;
  if (at === 0 && next !== null) nodes.visit(next, op);
  return 1;
}

function releaseHolder(h: Holder, at: usize, op: Visit): usize {
  const c = h.child;
  if (at === 0 && c !== null) nodes.visit(c, op);
  return 1;
}

const nodes = new Rc<Node>(releaseNode);
const holders = new Rc<Holder>(releaseHolder);

/** What an earlier case left waiting is freed first, so each case counts only its own objects. */
function settle(): void {
  holders.collect();
  nodes.collect();
}

/** A list of counted nodes, each holding the next one's count, summed, then dropped from its head: nothing left. */
export function chain(len: u32): u32 {
  settle();
  const base = nodes.size;
  let head: Counted<Node> | null = null;
  for (let i: u32 = 0; i < len; i++) {
    const n = nodes.make(new Node(i));
    n.next = head === null ? null : nodes.take(head);
    head = n;
  }
  let sum: u32 = 0;
  for (let p = head; p !== null; p = p.next) sum += p.v;
  if (head !== null) nodes.drop(head);
  nodes.collect();
  return sum * 1000 + toU32(nodes.size - base);
}

/** Two counts on one object: dropping one leaves it, with a count of one; dropping the other frees it. */
export function shareThenDrop(): u32 {
  settle();
  const base = nodes.size;
  const a = nodes.make(new Node(7));
  const b = nodes.share(a);
  const both = nodes.count(b);
  nodes.drop(a);
  nodes.collect();
  const left = nodes.count(b) * 10 + b.v;
  nodes.drop(b);
  nodes.collect();
  return both * 1000 + left * 10 + toU32(nodes.size - base);
}

/**
 * A copy of a handle that isn't a share holds no count: once the object goes, a use of it read from memory traps 5. So
 * does a use of a stale copy in a local (R1b): every counted class shares one heap, so the slot may hold another class
 * by then, and a reference to a class an `Rc` holds is checked wherever it came from.
 */
let kept: Counted<Node> | null = null;

export function staleCopy(): u32 {
  const a = nodes.make(new Node(3));
  kept = a;
  nodes.drop(a);
  nodes.collect();
  const k = kept;
  return k === null ? 0 : k.v;
}

/** A count dropped twice: the second has nothing to drop, and traps 5. */
export function droppedTwice(): u32 {
  const a = nodes.make(new Node(3));
  const copy = a;
  nodes.drop(a);
  nodes.drop(copy);
  return 0;
}

/** A field's count replaced: the old child goes, the new one stays, and dropping the holder frees the rest. */
export function replaceChild(): u32 {
  settle();
  const base = nodes.size + holders.size;
  const h = holders.make(new Holder(1));
  h.child = nodes.make(new Node(5));
  const first = nodes.count(h.child!);
  h.child = nodes.replace(h.child, nodes.make(new Node(6)));
  nodes.collect();
  const mid = toU32(nodes.size + holders.size - base) * 100 + h.child!.v;
  holders.drop(h);
  holders.collect();
  nodes.collect();
  return first * 100000 + mid * 10 + toU32(nodes.size + holders.size - base);
}

/**
 * Freeing is bounded: a dropped list of 1,000 goes a node a `make`, not all at once. Node can be in a cycle, so the
 * collector is linked, and then an allocation frees one object, a slot and a block, unless its size's list is empty
 * (D41's phase-E rule, as the direct route's, R1e). Until R1e this pinned 9850: 32 steps, 16 nodes.
 */
export function boundedFreeing(): u32 {
  settle();
  const base = nodes.size;
  let head: Counted<Node> | null = null;
  for (let i: u32 = 0; i < 1000; i++) {
    const n = nodes.make(new Node(i));
    n.next = head === null ? null : nodes.take(head);
    head = n;
  }
  if (head !== null) nodes.drop(head);
  const one = nodes.make(new Node(1));
  const afterOne = toU32(nodes.size - base);
  nodes.drop(one);
  nodes.collect();
  return afterOne * 10 + toU32(nodes.size - base);
}

/**
 * A cycle is collected (D41, R1c): two nodes holding each other, dropped, go when `collect` runs the cycle collector to
 * completion, as Node can be in a cycle (its `next` is a Node). Until R1c this pinned 2, the leak.
 */
export function cycleCollected(): u32 {
  settle();
  const base = nodes.size;
  const a = nodes.make(new Node(1));
  const b = nodes.make(new Node(2));
  a.next = nodes.share(b);
  b.next = nodes.share(a);
  nodes.drop(a);
  nodes.drop(b);
  nodes.collect();
  return toU32(nodes.size - base);
}

/** Slots are reused once freed, so a long run of make and drop stays in one chunk. */
export function reuse(n: u32): bool {
  settle();
  const base = nodes.size;
  for (let i: u32 = 0; i < n; i++) {
    const a = nodes.make(new Node(i));
    nodes.drop(a);
  }
  nodes.collect();
  return nodes.size === base;
}

/** A stale copy in a local, after its slot went to another class the same size: using it traps 5, natively too (R1b). */
export function staleLocal(): u32 {
  settle();
  const a = nodes.make(new Node(3));
  const copy = a;
  nodes.drop(a);
  nodes.collect();
  const h = holders.make(new Holder(77)); // a Holder is a Node's size: it takes the slot the Node had
  const v = copy.v;
  holders.drop(h);
  return v;
}
