// bench/memory/cycles_lowered.ts in `rc` TSL (R1c, D41): n objects in total, as rings of 16, doubly linked lists of 16, and
// objects with a closure over `this`, here an environment class referring back to its object, as TSL proper can't store a
// capturing closure. Every one is garbage in a cycle once its round ends, so @tsl/gc's cycle collector is the only thing
// that frees them. Beside the direct route's lowered program in rc with its collector on (`tmk bench memory --rc-tsl`).
import { type u32 } from "@tsl/core";

class Ring {
  next: Ring | null = null;
  constructor(public v: u32) {}
}
class Link {
  prev: Link | null = null;
  next: Link | null = null;
  constructor(public v: u32) {}
}
class Box {
  op: BoxEnv | null = null;
  constructor(public k: u32) {}
}
class BoxEnv {
  constructor(public self: Box) {}
}

function call(e: BoxEnv): u32 {
  return e.self.k;
}

function box(j: u32): u32 {
  const b = new Box(j);
  b.op = new BoxEnv(b);
  const e = b.op;
  return e === null ? 0 : call(e);
}

export function listCycle(n: u32): u32 {
  let t: u32 = 0;
  const rounds = n >>> 6;
  for (let i: u32 = 0; i < rounds; i++) {
    const first = new Ring(i);
    let last = first;
    for (let j: u32 = 1; j < 16; j++) {
      const r = new Ring(j);
      last.next = r;
      last = r;
    }
    last.next = first;
    t = (t + first.next!.v) >>> 0;
    const head = new Link(i);
    let tail = head;
    for (let j: u32 = 1; j < 16; j++) {
      const c = new Link(j);
      c.prev = tail;
      tail.next = c;
      tail = c;
    }
    t = (t + tail.prev!.v) >>> 0;
    for (let j: u32 = 0; j < 16; j++) t = (t + box(j)) >>> 0;
  }
  return t;
}
