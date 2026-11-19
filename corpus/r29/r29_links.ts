// memory-pages: 64
// R29 (SPEC 3.5, D79): the table-links proof where it applies. Table keeps a chained table of keys as JsMap does: `heads`
// and `chain` hold links (a position plus 2; 0 is empty), and its claim says each names a position below the lengths of
// `keys` and `chain`. tslc proves it over every write (compiler/host/links.ts), so `find`'s two reads a chain step have no
// bounds check at -O1 and -O2 (tools/r29-tests.ts checks the TIR); every answer here is V8's, at every level.
import { u32, wrapU32, type i32, type usize } from "@tsl/core";
import { JsArray } from "@tsl/jsrt";

/** (s - 2) >>> 0 below this: s is a link. */
const LINKS: u32 = 0x7ffffffe;

/**
 * A chained table of up to `room` keys in `buckets` chains (a power of two). Positions fall along a chain.
 * @tsl.links heads chain < keys chain
 */
export class Table {
  private keys: JsArray<u32>;
  private chain: JsArray<u32>;
  private heads: JsArray<u32>;

  constructor(buckets: usize, room: usize) {
    this.keys = new JsArray(u32, 0, true, true);
    this.chain = new JsArray(u32, room, true, true);
    this.heads = new JsArray(u32, buckets, true, true);
  }

  get size(): usize {
    return this.keys.length;
  }

  private bucket(k: u32): usize {
    const h: u32 = Math.imul(k ^ (k >>> 15), 0x2c1b3c6d) >>> 0;
    return (h & wrapU32(this.heads.length - 1)) >>> 0;
  }

  /** Adds k (a key may be there twice); false once full. */
  add(k: u32): boolean {
    const at: u32 = wrapU32(this.keys.length);
    if (at >= wrapU32(this.chain.length)) return false;
    const b = this.bucket(k);
    this.keys.push(k);
    const s: u32 = this.heads.get(b);
    this.chain.set(at, s);
    this.heads.set(b, (at + 2) >>> 0);
    return true;
  }

  /** Where k last went in, or -1. */
  find(k: u32): i32 {
    let s: u32 = this.heads.get(this.bucket(k));
    let i: u32 = (s - 2) >>> 0;
    while (i < LINKS) {
      if (this.keys.get(i) === k) return i | 0;
      s = this.chain.get(i);
      i = (s - 2) >>> 0;
    }
    return -1;
  }

  /** How many keys k's chain walks past before k, or the whole chain's length. */
  steps(k: u32): u32 {
    let n: u32 = 0;
    let s: u32 = this.heads.get(this.bucket(k));
    let i: u32 = (s - 2) >>> 0;
    while (i < LINKS) {
      if (this.keys.get(i) === k) return n;
      n = (n + 1) >>> 0;
      s = this.chain.get(i);
      i = (s - 2) >>> 0;
    }
    return n;
  }

  /** Emptied: no link anywhere, and every length what it was made with. */
  clear(): void {
    const nb = this.heads.length;
    const room = this.chain.length;
    this.heads.setLength(0);
    this.heads.setLength(nb);
    this.chain.setLength(0);
    this.chain.setLength(room);
    this.keys.setLength(0);
  }
}

function mix(h: u32, x: u32): u32 {
  return Math.imul((h ^ x) >>> 0, 16777619) >>> 0;
}

/** n keys in, then every one found and some that aren't: a digest of where each is. */
export function build(n: u32, seed: u32): u32 {
  const T = new Table(16, 200);
  T.clear();
  for (let i: u32 = 0; i < n; i++) T.add(Math.imul(i, seed) >>> 0);
  let h: u32 = 0x811c9dc5;
  for (let i: u32 = 0; i < n + 10; i++) h = mix(h, wrapU32(T.find(Math.imul(i, seed) >>> 0) + 1));
  return mix(h, wrapU32(T.size));
}

/** Chains as long as they get: everything in a few buckets' worth of keys, and the steps to each. */
export function longChains(n: u32): u32 {
  const T = new Table(16, 200);
  for (let i: u32 = 0; i < n; i++) T.add(Math.imul(i & 3, 16) >>> 0);
  let h: u32 = 0;
  for (let i: u32 = 0; i < 6; i++) h = mix(h, T.steps(Math.imul(i, 16) >>> 0));
  return h;
}

/** Full: what doesn't fit is refused, and what did is all found. */
export function fill(extra: u32): u32 {
  const T = new Table(16, 200);
  for (let i: u32 = 0; i < 50; i++) T.add(i);
  T.clear();
  let refused: u32 = 0;
  for (let i: u32 = 0; i < 200 + extra; i++) if (!T.add(i)) refused++;
  let found: u32 = 0;
  for (let i: u32 = 0; i < 200 + extra; i++) if (T.find(i) >= 0) found++;
  return ((Math.imul(refused, 1000) >>> 0) + found) >>> 0;
}
