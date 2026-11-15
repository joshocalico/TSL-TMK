// `rc` in TSL proper (SPEC 3.5, D74): plain classes and `new`, counted by @tsl/gc after tslc expands them.
import { type u32 } from "@tsl/core";
import { rcCollect, rcLive } from "@tsl/gc";

class Node {
  next: Node | null = null;
  constructor(public v: u32) {}
}

class List {
  head: Node | null = null;
  len: u32 = 0;

  push(v: u32): void {
    const n = new Node(v);
    n.next = this.head;
    this.head = n;
    this.len++;
  }

  sum(): u32 {
    let s: u32 = 0;
    for (let p = this.head; p !== null; p = p.next) s += p.v;
    return s;
  }
}

let _kept: List | null = null;

/** A list built, summed and dropped: nothing left once what's waiting is freed. */
export function build(n: u32): u32 {
  rcCollect();
  const base = rcLive();
  const l = new List();
  for (let i: u32 = 0; i < n; i++) l.push(i);
  const s = l.sum();
  _kept = l;
  _kept = null;
  rcCollect();
  return s * 10 + (rcLive() === base ? 1 : 0);
}
