// file: ex-jsrt-array.ts
import { toU64, Trap, trap, u16, u32, u64, u8, type bool, type usize } from "@tsl/core";
import {
  addrInCallRegion,
  bytesAt,
  callRegionBytes,
  copyBytes,
  elemSize,
  inCallRegion,
  ptrAt,
  type ElemOf,
  type Ptr,
} from "@tsl/unsafe";
import { heap } from "@tsl/std";

/**
 * A JS array of T, with JS's rules where TSL can say them (D66): `length`, `push`, `pop`, `shift`, indexing, growth and
 * holes. A hole is a zeroed slot, which reads as `null` in an array of references, as a JS hole reads `undefined`; an
 * array of numbers can't have one, so where JS would make one this traps 15, as lowered code does. Elements live in a
 * buffer from the global allocator that doubles as it fills, from 4, and goes back to it when it's replaced. Lowered
 * programs print their arrays as this class (`tmk lower --emit tsl`), and a person can write it too. An array tslc placed
 * in a lowered package's per-call region (R6) takes its buffers from the region, which the export call gives back whole,
 * so none of those is given back to the global allocator.
 */
export class JsArray<T> {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  /**
   * `length` elements, each zero: JS's `new Array(length)` with its holes, or `[]`. `giveBack` false keeps each buffer
   * the array outgrows, as a `leak` package's lowered arrays always have (3.5), where true gives it back.
   */
  constructor(
    private elem: ElemOf<T>,
    length: usize,
    private giveBack: bool,
  ) {
    this.grow(length < 4 ? 4 : length);
    this.len = length;
  }

  /** @tsl.inline */
  get length(): usize {
    return this.len;
  }

  /** The room the buffer has, in elements: 0 once `trim` gave it back. */
  /** @tsl.inline */
  get capacity(): usize {
    return this.cap;
  }

  /** @tsl.inline */
  // SAFETY: i is at most cap, so the address is in the buffer or just past it: an element step, with nothing to check.
  private slot(i: usize): Ptr<T> {
    return ptrAt(this.elem, this.data).add(i);
  }

  /** @tsl.inline */
  private at(i: usize): u64 {
    return this.slot(i).addr;
  }

  /** `a[i]`; past the end traps 2 (`a[i]!`): a hole reads as zero, `null` for a reference. Inlined at every level that
   * inlines (R4), as JsRoomArray's is: a map's lookups make several a call, and at -O1 each was a call. */
  /** @tsl.inline */
  // SAFETY: i is below len, so its slot is in the buffer.
  get(i: usize): T {
    if (i >= this.len) trap(Trap.Bounds);
    return this.slot(i).read();
  }

  /** `a[i] = v` below the length. Past it, `setLength` first, which is where JS's holes come from. */
  /** @tsl.inline */
  // SAFETY: i is below len, so its slot is in the buffer.
  set(i: usize, v: T): T {
    if (i >= this.len) trap(Trap.Bounds);
    this.slot(i).write(v);
    return v;
  }

  /** Appends v and gives the new length, as JS's `push` does. */
  // SAFETY: grow left room for one more, so the slot at len is in the buffer.
  push(v: T): usize {
    const n = this.len;
    if (n === this.cap) this.grow(n + 1);
    this.slot(n).write(v);
    const m = n + 1;
    this.len = m;
    return m;
  }

  /** The last element, removed; on an empty array, `none`, and the array stays empty, as JS's `pop` gives `undefined`. */
  // SAFETY: n is above zero, so the slot at n - 1 is in the buffer.
  pop(none: T): T {
    const n = this.len;
    if (n === 0) return none;
    const v = this.slot(n - 1).read();
    this.setLength(n - 1);
    return v;
  }

  /** The first element, removed, with every other moved down one; on an empty array, `none`, as JS's `shift`. */
  // SAFETY: n is above zero, so slots 0 to n - 1 are in the buffer, and the copy moves n - 1 of them down one.
  shift(none: T): T {
    const n = this.len;
    if (n === 0) return none;
    const v = this.slot(0).read();
    copyBytes(this.at(0), this.at(1), (n - 1) * elemSize(this.elem));
    this.setLength(n - 1);
    return v;
  }

  /** Room for `n` elements without moving the buffer again. */
  reserve(n: usize): void {
    if (n > this.cap) this.grow(n);
  }

  /**
   * R11: `reserve`, where running out of memory gives false and leaves the array as it was, as `reserve` traps 14: a map
   * whose tables are held by a counted object frees what the counted heap has waiting, then asks again (`JsMap.tablesIn`).
   * The block growth would take is asked for and given straight back first, so growth then finds it (the allocator's own
   * list for its size, or @tsl/std's runs of whole pages); an array in the per-call region grows there, as it always does.
   */
  // SAFETY: the block is the allocator's, taken and given back at the size it was taken with, and nothing kept of it.
  tryReserve(n: usize): bool {
    if (n <= this.cap) return true;
    if (!inCallRegion(this)) {
      const twice = this.cap * 2;
      const want = (twice < n ? n : twice) * elemSize(this.elem);
      const probe = heap.allocBytes(want);
      if (probe === 0n) return false;
      heap.freeBytes(probe, want);
    }
    this.grow(n);
    return true;
  }

  /** JS's `a.length = n` within what's reserved: shorter drops elements, longer adds holes. Gives n. */
  // SAFETY: the slots from n to len are below cap.
  setLength(n: usize): usize {
    if (n > this.cap) trap(Trap.Bounds);
    if (n < this.len) this.clear(n, this.len);
    this.len = n;
    return n;
  }

  /**
   * The buffer given back, where the array gives buffers back, and the array left empty: true if it had one. It's the
   * last step of freeing a lowered `rc` package's array (R2), after its counted elements have been moved out.
   */
  // SAFETY: the buffer is cap elements from the global allocator, given back at that size, and nothing reads it after:
  // the length is 0, so no slot is in reach.
  trim(): bool {
    if (this.cap === 0) return false;
    if (this.giveBack && !addrInCallRegion(this.data))
      heap.freeBytes(this.data, this.cap * elemSize(this.elem));
    this.len = 0;
    this.data = 0n;
    this.cap = 0;
    return true;
  }

  /**
   * Takes `from`'s buffer, length and room, giving its own buffer back first as `trim` does, and leaves `from` empty with
   * none: a map moves a table into its old one so, without making an array (R2).
   */
  adopt(from: JsArray<T>): void {
    this.trim();
    this.data = from.data;
    this.len = from.len;
    this.cap = from.cap;
    from.data = 0n;
    from.len = 0;
    from.cap = 0;
  }

  /**
   * Exchanges buffer, length and room with `other` (R4): how a map that has made a new table's buffers in its old table's
   * arrays puts them in place, once nothing more can run out of memory. Both are arrays of the same element, made alike.
   */
  swap(other: JsArray<T>): void {
    const d = this.data;
    const n = this.len;
    const c = this.cap;
    this.data = other.data;
    this.len = other.len;
    this.cap = other.cap;
    other.data = d;
    other.len = n;
    other.cap = c;
  }

  /** Slot i, below the length, made a hole: zero, `null` for a reference (R2: a map's slot it no longer holds). */
  zero(i: usize): void {
    if (i >= this.len) trap(Trap.Bounds);
    this.clear(i, i + 1);
  }

  /** Calls f on each element and its index, in order, up to the length when it started; f mustn't change the length. */
  forEach(f: (x: T, i: usize) => void): void {
    const n = this.len;
    for (let i: usize = 0; i < n; i++) f(this.get(i), i);
  }

  // SAFETY: the slots from `from` to `to` are below cap, so these are the buffer's, a whole element at a time; an
  // element's size is a constant, so one arm is left.
  private clear(from: usize, to: usize): void {
    const size = elemSize(this.elem);
    const end = this.at(to);
    for (let a = this.at(from); a < end; a = a + toU64(size)) {
      if (size === 8) ptrAt(u64, a).write(0n);
      else if (size === 4) ptrAt(u32, a).write(0);
      else if (size === 2) ptrAt(u16, a).write(0);
      else ptrAt(u8, a).write(0);
    }
  }

  // SAFETY: the new block holds ncap elements, at least len; the first len are copied from the old one and the rest
  // zeroed, and the old block goes back to the allocator with the size it was taken with, unless it's the per-call
  // region's (R6), which gives back nothing a block at a time. An array in the region grows in it.
  private grow(need: usize): void {
    const dbl = this.cap * 2;
    const ncap = dbl < need ? need : dbl;
    const size = elemSize(this.elem);
    const bytes = ncap * size;
    const next = inCallRegion(this) ? callRegionBytes(bytes) : heap.allocBytes(bytes);
    if (next === 0n) trap(Trap.OutOfMemory);
    const kept = this.len * size;
    if (this.data !== 0n) {
      copyBytes(next, this.data, kept);
      if (this.giveBack && !addrInCallRegion(this.data)) heap.freeBytes(this.data, this.cap * size);
    }
    bytesAt(next + toU64(kept), bytes - kept).fill(0);
    this.data = next;
    this.cap = ncap;
  }
}
