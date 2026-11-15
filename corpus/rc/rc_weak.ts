// WeakRef in an `rc` package (SPEC 3.5, D39, D74): `new WeakRef(x)` holds no count, `deref` gives the object while its
// count is above zero, and `undefined` from the moment it reaches zero: while it waits to be freed, after it's freed, and
// after its slot holds another object. Nothing is ever brought back. V8 may keep a target longer (3.10, item 9), so the
// cases that drop a target are `rcOnly`, and pinned.
import { type u32 } from "@tsl/core";
import { rcCollect } from "@tsl/gc";

class Node {
  constructor(public v: u32) {}
}

class Cache {
  w: WeakRef<Node> | null = null;
}

let strong: Node | null = null;

function peek(w: WeakRef<Node>): u32 {
  const t = w.deref();
  return t === undefined ? 0 : t.v;
}

/** A target held elsewhere: deref gives it. */
export function held(n: u32): u32 {
  strong = new Node(n);
  const w = new WeakRef(strong);
  const r = peek(w);
  strong = null;
  return r;
}

/** Dropped: undefined at once, before anything is freed, then freed, then its slot reused. */
export function cleared(n: u32): u32 {
  rcCollect();
  const cache = new Cache();
  strong = new Node(n);
  cache.w = new WeakRef(strong);
  const before = peek(cache.w);
  strong = null;
  const waiting = peek(cache.w);
  rcCollect();
  const freed = peek(cache.w);
  strong = new Node(n + 1);
  const reused = peek(cache.w);
  strong = null;
  cache.w = null;
  return before * 1000 + waiting * 100 + freed * 10 + reused;
}

/** What deref gives holds its own count: dropping the only other holder leaves it usable. */
export function derefHolds(n: u32): u32 {
  strong = new Node(n);
  const w = new WeakRef(strong);
  const t = w.deref();
  strong = null;
  rcCollect();
  const v = t === undefined ? 0 : t.v;
  return v;
}
