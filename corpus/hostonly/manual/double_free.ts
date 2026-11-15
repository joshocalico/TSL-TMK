// Host only (SPEC 3.10, divergence 8): freeing an object twice traps with code 5 on the host. Natively it's a real bug,
// with nothing to check it, so this can't be in the native corpus.
import { type u32 } from "@tsl/core";
import { unsafeFree } from "@tsl/unsafe";

export class Obj {
  constructor(public v: u32) {}
}

export function freeOnce(v: u32): u32 {
  const o = new Obj(v);
  const got = o.v;
  // SAFETY: nothing else holds o, and it's not used after this.
  unsafeFree(o);
  return got;
}

export function freeTwice(v: u32): u32 {
  const o = new Obj(v);
  // SAFETY: the first free is sound.
  unsafeFree(o);
  // SAFETY: this one isn't: it's the bug under test, on the host, where it traps.
  unsafeFree(o);
  return v;
}
