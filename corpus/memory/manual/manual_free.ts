// memory-pages: 4
// unsafeFree (SPEC 3.5, 3.10 divergence 8): normal free, reuse, and use after free, which traps with code 5 on
// the host and natively is a real bug. A freed block is the next one of its size, and that's what's pinned here.
import { type u32, type usize } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

export class Obj {
  link: Obj | null = null;
  constructor(public v: u32) {}
}

export function normalFree(v: u32): u32 {
  const o = new Obj(v);
  const got = o.v;
  // SAFETY: nothing else holds o, and it's not used after this.
  unsafeFree(o);
  return got;
}

/** Far more than 4 pages' worth, if a free didn't give the block back. */
export function reuse(n: usize): u32 {
  let last: u32 = 0;
  for (let i = 0; i < n; i++) {
    const o = new Obj(7);
    o.link = null;
    last = o.v;
    // SAFETY: o is this iteration's own, and is gone by the next.
    unsafeFree(o);
  }
  return last;
}

export function useAfterFree(v: u32): u32 {
  const o = new Obj(v);
  // SAFETY: deliberately not. This is the test of what using it afterwards does.
  unsafeFree(o);
  return o.v;
}

export function reusedUnderStale(a: u32, b: u32): u32 {
  const o = new Obj(a);
  // SAFETY: deliberately not. This shows the block being reused under a stale reference.
  unsafeFree(o);
  const p = new Obj(b);
  const seen = o.v;
  // SAFETY: p is ours.
  unsafeFree(p);
  return seen;
}
