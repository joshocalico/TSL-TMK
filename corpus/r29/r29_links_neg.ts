// memory-pages: 64
// R29 (SPEC 3.5, D79): where the table-links proof must NOT apply, and what each injected bug would get wrong. Each class
// claims its links are below its keys' length, as r29_links.ts's Table does, and each breaks the claim one way: a link
// stored past the keys, the keys cut short with links left to them, two tables swapped by halves, and the keys cut from
// outside the class. So tslc refuses each claim, every bounds check stays (the build is the same with the proof on and
// off: tools/r29-tests.ts), and each lookup past the keys traps 2, at every level, as V8 does. Under R29's bugs
// (tools/r29-tests.ts's R29_FAULTS) the check goes, and the read past the keys gives a number, not the trap. Reent's lookup
// calls a function value that may empty it between a link's read and its use, so its reads keep their checks too.
import { u32, wrapU32, type i32, type usize } from "@tsl/core";
import { JsArray } from "@tsl/jsrt";

const LINKS: u32 = 0x7ffffffe;

function bucketOf(k: u32): usize {
  return (Math.imul(k, 0x9e3779b1) >>> 28) & 3;
}

/**
 * A link stored one past the key it should name.
 * @tsl.links heads < keys
 */
export class BadStore {
  private keys: JsArray<u32>;
  private heads: JsArray<u32>;

  constructor() {
    this.keys = new JsArray(u32, 0, true, true);
    this.heads = new JsArray(u32, 4, true, true);
  }

  add(k: u32): void {
    const at: u32 = wrapU32(this.keys.length);
    this.keys.push(k);
    this.heads.set(bucketOf(k), (at + 3) >>> 0);
  }

  first(k: u32): u32 {
    const i: u32 = (this.heads.get(bucketOf(k)) - 2) >>> 0;
    if (i < LINKS) return this.keys.get(i);
    return 0;
  }
}

/**
 * The keys cut short, the links to them left.
 * @tsl.links heads < keys
 */
export class BadShrink {
  private keys: JsArray<u32>;
  private heads: JsArray<u32>;

  constructor() {
    this.keys = new JsArray(u32, 0, true, true);
    this.heads = new JsArray(u32, 4, true, true);
  }

  add(k: u32): void {
    const at: u32 = wrapU32(this.keys.length);
    this.keys.push(k);
    this.heads.set(bucketOf(k), (at + 2) >>> 0);
  }

  drop(): void {
    this.keys.setLength(0);
  }

  first(k: u32): u32 {
    const i: u32 = (this.heads.get(bucketOf(k)) - 2) >>> 0;
    if (i < LINKS) return this.keys.get(i);
    return 0;
  }
}

/**
 * Two tables, swapped by halves: the heads change places, the keys don't.
 * @tsl.links heads < keys
 * @tsl.links oheads < okeys
 */
export class BadSwap {
  private keys: JsArray<u32>;
  private heads: JsArray<u32>;
  private okeys: JsArray<u32>;
  private oheads: JsArray<u32>;

  constructor() {
    this.keys = new JsArray(u32, 0, true, true);
    this.heads = new JsArray(u32, 4, true, true);
    this.okeys = new JsArray(u32, 0, true, true);
    this.oheads = new JsArray(u32, 4, true, true);
  }

  add(k: u32): void {
    const at: u32 = wrapU32(this.keys.length);
    this.keys.push(k);
    this.heads.set(bucketOf(k), (at + 2) >>> 0);
  }

  flip(): void {
    this.heads.swap(this.oheads);
  }

  firstOld(k: u32): u32 {
    const i: u32 = (this.oheads.get(bucketOf(k)) - 2) >>> 0;
    if (i < LINKS) return this.okeys.get(i);
    return 0;
  }
}

/**
 * Its keys open to code outside the class, which cuts them.
 * @tsl.links heads < keys
 */
export class Outside {
  keys: JsArray<u32>;
  private heads: JsArray<u32>;

  constructor() {
    this.keys = new JsArray(u32, 0, true, true);
    this.heads = new JsArray(u32, 4, true, true);
  }

  add(k: u32): void {
    const at: u32 = wrapU32(this.keys.length);
    this.keys.push(k);
    this.heads.set(bucketOf(k), (at + 2) >>> 0);
  }

  first(k: u32): u32 {
    const i: u32 = (this.heads.get(bucketOf(k)) - 2) >>> 0;
    if (i < LINKS) return this.keys.get(i);
    return 0;
  }
}

/** Cuts an Outside's keys from outside it. */
function cut(o: Outside): void {
  o.keys.setLength(0);
}

export type Hook = () => void;

/** What Reent's lookup calls between a link's read and its use. */
export class Hooks {
  constructor(public f: Hook) {}
}

function nothing(): void {}

let hooks: Hooks | null = null;
let current: Reent | null = null;

/**
 * Sound, but its lookup calls a function value that may run its own `clear`: the read after it keeps its check.
 * @tsl.links heads < keys
 */
export class Reent {
  private keys: JsArray<u32>;
  private heads: JsArray<u32>;

  constructor() {
    this.keys = new JsArray(u32, 0, true, true);
    this.heads = new JsArray(u32, 4, true, true);
  }

  add(k: u32): void {
    const at: u32 = wrapU32(this.keys.length);
    this.keys.push(k);
    this.heads.set(bucketOf(k), (at + 2) >>> 0);
  }

  clear(): void {
    this.keys.setLength(0);
    this.heads.setLength(0);
    this.heads.setLength(4);
  }

  first(k: u32): u32 {
    const i: u32 = (this.heads.get(bucketOf(k)) - 2) >>> 0;
    if (hooks !== null) {
      const f = hooks.f;
      f();
    }
    if (i < LINKS) return this.keys.get(i);
    return 0;
  }
}

/** One key in: its link names the slot past it, so its lookup traps 2 (a number, under the bug). */
export function badStore(k: u32): u32 {
  const S = new BadStore();
  S.add(k);
  return S.first(k);
}

/** Keys in, then cut to none: a lookup through a link left traps 2. */
export function badShrink(k: u32, cutFirst: i32): u32 {
  const H = new BadShrink();
  H.add(k);
  H.add((k + 1) >>> 0);
  if (cutFirst !== 0) H.drop();
  return H.first(k);
}

/** A key in, the heads swapped alone: the old heads' link names a key the old keys don't have. */
export function badSwap(k: u32): u32 {
  const W = new BadSwap();
  W.add(k);
  W.flip();
  return W.firstOld(k);
}

/** A key in, the keys cut from outside: its lookup traps 2. */
export function outside(k: u32, cutFirst: i32): u32 {
  const O = new Outside();
  O.add(k);
  if (cutFirst !== 0) cut(O);
  return O.first(k);
}

function emptyR(): void {
  if (current !== null) current.clear();
}

/** A key in, then a lookup whose hook empties the table: the read after it traps 2. */
export function reent(k: u32, empty: i32): u32 {
  const R = new Reent();
  current = R;
  R.add(k);
  hooks = new Hooks(empty !== 0 ? emptyR : nothing);
  const v = R.first(k);
  hooks = null;
  current = null;
  return v;
}
