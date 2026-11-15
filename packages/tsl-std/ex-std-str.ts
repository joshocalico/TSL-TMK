// file: ex-std-str.ts
import { Slab as AllocSlab, Vec as AllocVec } from "@tsl/alloc";
import { idiv, toI32, Trap, trap, u8, wrapU32, wrapU8, type bool, type i32, type u32, type usize } from "@tsl/core";
import { heap, hashKeyWord } from "./ex-std-global.ts";
import type { Vec } from "./ex-std-vec.ts";

/**
 * A run-time string: immutable UTF-8 bytes in a slot of a Slab of its own, so it can be stored and returned in `strict`,
 * and every stored reference to it traps 5 once it's freed. Reading is by byte, as lit() gives UTF-8.
 */
export class Str {
  private b: AllocVec<u8> = new AllocVec(u8, heap);
  private hashed: bool = false;
  private h: u32 = 0;

  /** Copies the bytes. Traps 14 out of memory. */
  static of(bytes: Uint8Array): Str {
    const s = Str.tryOf(bytes);
    if (s === null) trap(Trap.OutOfMemory);
    return s;
  }

  /** Null when out of memory. */
  static tryOf(bytes: Uint8Array): Str | null {
    const s = strs.add(new Str());
    if (s === null) return null;
    for (const x of bytes) {
      if (!s.b.push(x)) {
        s.free();
        return null;
      }
    }
    return s;
  }

  /** A copy of a Vec's bytes, which is what a builder has. */
  static ofVec(v: AllocVec<u8>): Str {
    const s = strs.add(new Str());
    if (s === null) trap(Trap.OutOfMemory);
    v.withSlice((a) => {
      s.pushBytes(a);
    });
    return s;
  }

  private pushBytes(a: Uint8Array): void {
    for (const x of a) {
      if (!this.b.push(x)) trap(Trap.OutOfMemory);
    }
  }

  get length(): usize {
    return this.b.length;
  }

  at(i: usize): u8 {
    return this.b.get(i);
  }

  /** The bytes, lent: the slice can't be stored or outlive the call, and `free` during it traps 13. */
  withBytes(f: (s: Uint8Array) => void): void {
    this.b.withSlice(f);
  }

  equals(o: Str): bool {
    return this.b.length === o.b.length && this.compare(o) === 0;
  }

  /** By byte, then by length, which is UTF-8's order of code points. */
  compare(o: Str): i32 {
    const n = this.b.length;
    const m = o.b.length;
    const shortest = n < m ? n : m;
    let out: i32 = 0;
    this.withBytes((a) => {
      o.withBytes((c) => {
        for (let i: usize = 0; i < shortest && out === 0; i++) {
          if (a[i]! !== c[i]!) out = a[i]! < c[i]! ? -1 : 1;
        }
      });
    });
    if (out !== 0) return out;
    if (n === m) return 0;
    return n < m ? -1 : 1;
  }

  /** From start up to end, copied. Traps 2 if that's not within it. */
  slice(start: usize, end: usize): Str {
    if (start > end || end > this.b.length) trap(Trap.Bounds);
    const s = strs.add(new Str());
    if (s === null) trap(Trap.OutOfMemory);
    this.withBytes((a) => {
      s.pushBytes(a.subarray(start, end));
    });
    return s;
  }

  concat(o: Str): Str {
    const s = strs.add(new Str());
    if (s === null) trap(Trap.OutOfMemory);
    this.withBytes((a) => {
      s.pushBytes(a);
    });
    o.withBytes((a) => {
      s.pushBytes(a);
    });
    return s;
  }

  /** The first place o is, from `from` on, or -1. The naive search, so O(n·m) on a bad input. */
  indexOf(o: Str, from: usize): i32 {
    const n = this.b.length;
    const m = o.b.length;
    if (m === 0) return from <= n ? toI32(from) : -1;
    let out: i32 = -1;
    this.withBytes((a) => {
      o.withBytes((c) => {
        for (let i = from; i + m <= n && out < 0; i++) {
          let j: usize = 0;
          while (j < m && a[i + j]! === c[j]!) j++;
          if (j === m) out = toI32(i);
        }
      });
    });
    return out;
  }

  /** Each run between `sep`s goes in `out` as a new Str, empty runs too. */
  split(sep: u8, out: Vec<Str>): void {
    const n = this.b.length;
    let start: usize = 0;
    for (let i: usize = 0; i <= n; i++) {
      if (i === n || this.b.get(i) === sep) {
        out.push(this.slice(start, i));
        start = i + 1;
      }
    }
  }

  /** HalfSipHash-1-3 (D42), under the same key as other keys, and kept: a Str doesn't change. */
  hashKey(): u32 {
    if (!this.hashed) {
      this.h = halfSip13(this);
      this.hashed = true;
    }
    return this.h;
  }

  sameKey(o: Str): bool {
    return this.equals(o);
  }

  /** Gives back its bytes and its slot. Every stored reference to it traps 5 from now on. */
  free(): void {
    this.b.free();
    strs.remove(this);
  }

  [Symbol.dispose](): void {
    this.free();
  }
}

const strs = new AllocSlab<Str>(heap, 32);

function halfSip13(s: Str): u32 {
  const k0 = hashKeyWord(0);
  const k1 = hashKeyWord(1);
  let v0: u32 = k0;
  let v1: u32 = k1;
  let v2: u32 = (0x6c796765 ^ k0) >>> 0;
  let v3: u32 = (0x74656462 ^ k1) >>> 0;
  const round = (): void => {
    v0 = (v0 + v1) >>> 0;
    v1 = ((v1 << 5) | (v1 >>> 27)) >>> 0;
    v1 = (v1 ^ v0) >>> 0;
    v0 = ((v0 << 16) | (v0 >>> 16)) >>> 0;
    v2 = (v2 + v3) >>> 0;
    v3 = ((v3 << 8) | (v3 >>> 24)) >>> 0;
    v3 = (v3 ^ v2) >>> 0;
    v0 = (v0 + v3) >>> 0;
    v3 = ((v3 << 7) | (v3 >>> 25)) >>> 0;
    v3 = (v3 ^ v0) >>> 0;
    v2 = (v2 + v1) >>> 0;
    v1 = ((v1 << 13) | (v1 >>> 19)) >>> 0;
    v1 = (v1 ^ v2) >>> 0;
    v2 = ((v2 << 16) | (v2 >>> 16)) >>> 0;
  };
  let word: u32 = 0;
  let shift: u32 = 0;
  s.withBytes((a) => {
    for (const x of a) {
      word = (word | (x << shift)) >>> 0;
      shift += 8;
      if (shift === 32) {
        v3 = (v3 ^ word) >>> 0;
        round();
        v0 = (v0 ^ word) >>> 0;
        word = 0;
        shift = 0;
      }
    }
  });
  word = (word | (wrapU32(s.length) << 24)) >>> 0;
  v3 = (v3 ^ word) >>> 0;
  round();
  v0 = (v0 ^ word) >>> 0;
  v2 = (v2 ^ 0xff) >>> 0;
  round();
  round();
  round();
  return (v1 ^ v3) >>> 0;
}

/** Text made a piece at a time: a growable buffer, which `finish` copies once, so appending isn't quadratic. */
export class StrBuilder {
  private b: AllocVec<u8> = new AllocVec(u8, heap);
  private freed: bool = false;

  get length(): usize {
    return this.b.length;
  }

  appendByte(x: u8): void {
    if (!this.b.push(x)) trap(Trap.OutOfMemory);
  }

  appendBytes(a: Uint8Array): void {
    for (const x of a) this.appendByte(x);
  }

  append(s: Str): void {
    s.withBytes((a) => {
      this.appendBytes(a);
    });
  }

  /** False when out of memory, with as much appended as fitted. */
  tryAppendBytes(a: Uint8Array): bool {
    for (const x of a) {
      if (!this.b.push(x)) return false;
    }
    return true;
  }

  /** In decimal. */
  appendU32(x: u32): void {
    if (x >= 10) this.appendU32(idiv(x, 10));
    this.appendByte(wrapU8(48 + x % 10));
  }

  appendI32(x: i32): void {
    if (x < 0) this.appendByte(45);
    this.appendU32(x < 0 ? ((~x >>> 0) + 1) >>> 0 : x >>> 0); // -x overflows at the least i32
  }

  /** A new Str with what's been appended, and the builder can go on. Traps 14 out of memory. */
  finish(): Str {
    return Str.ofVec(this.b);
  }

  free(): void {
    this.freed = true;
    this.b.free();
  }

  [Symbol.dispose](): void {
    if (!this.freed) this.free();
  }
}
