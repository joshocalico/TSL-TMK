// file: ex-jsrt-arena.ts
import { toU64, Trap, trap, u16, u32, u64, u8, type usize } from "@tsl/core";
import {
  bytesAt,
  callRegionBytes,
  copyBytes,
  elemSize,
  ptrAt,
  type ElemOf,
  type Ptr,
} from "@tsl/unsafe";
export { ref } from "@tsl/unsafe";

/**
 * A JS array of T for a lowered `strict` package (R13), which has no heap: `JsArray`'s rules (D66), `length`, `get`, `set`,
 * `push`, `pop`, `shift`, `setLength`, `reserve`, holes as zeroed slots, with its buffers only from the call arena the
 * export call runs in (`callRegionBytes`), never `@tsl/std`'s heap. The arena belongs to the caller, who resets it between
 * calls (D36), so nothing here is ever given back: an outgrown buffer stays where it was until the reset, as the direct
 * route's call-bounded vectors' do. tslc places the array itself in the arena too (region.ts), and refuses the printing of
 * a program where one could outlive the export call. Growth past what the arena has left traps 14, as every arena
 * allocation does. Only `tmk lower` prints it, into a package whose tsl.json says "lowered" (TSL1023); on a JS engine the
 * arena is simulated memory nothing gives back (`callRegionBytes` in @tsl/unsafe).
 */
export class JsArenaArray<T> {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;

  /** `length` elements, each zero: JS's `new Array(length)` with its holes, or `[]`. */
  // R16: made at its final size in one step, as the direct route's `__vec_new` makes a vector: one block of max(length, 4)
  // elements from the arena, zeroed, and no growth path. Inlined at every level that inlines, so a constant length folds.
  /** @tsl.inline */
  // SAFETY: the block is ncap elements of the call arena, at least length, which traps 14 where it has no room, so it's
  // never 0; nothing else has it.
  constructor(
    private elem: ElemOf<T>,
    length: usize,
  ) {
    const ncap = length < 4 ? 4 : length;
    const bytes = ncap * elemSize(elem);
    const block = callRegionBytes(bytes);
    if (block === 0n) trap(Trap.OutOfMemory);
    bytesAt(block, bytes).fill(0);
    this.data = block;
    this.cap = ncap;
    this.len = length;
  }

  /** @tsl.inline */
  get length(): usize {
    return this.len;
  }

  /** The room the buffer has, in elements. */
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

  /** `a[i]`; past the end traps 2 (`a[i]!`): a hole reads as zero, `null` for a reference. */
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

  /**
   * Appends v and gives the new length, as JS's `push` does. R16: inlined at every level that inlines, as the direct
   * route's push is: with room left, a store and the length bumped; full, `pushGrow`, out of line.
   */
  /** @tsl.inline */
  // SAFETY: n is below cap, so the slot at n is in the buffer.
  push(v: T): usize {
    const n = this.len;
    if (n >= this.cap) return this.pushGrow(v);
    this.slot(n).write(v);
    const m = n + 1;
    this.len = m;
    return m;
  }

  /** `push` on a full array: the buffer doubled (`grow`), then the store. Out of line, so `push` stays small. */
  /** @tsl.noinline */
  // SAFETY: grow left room for one more, so the slot at len is in the buffer.
  private pushGrow(v: T): usize {
    const n = this.len;
    this.grow(n + 1);
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

  /** JS's `a.length = n` within what's reserved: shorter drops elements, longer adds holes. Gives n. R16: inlined. */
  /** @tsl.inline */
  // SAFETY: the slots from n to len are below cap.
  setLength(n: usize): usize {
    if (n > this.cap) trap(Trap.Bounds);
    if (n < this.len) this.clear(n, this.len);
    this.len = n;
    return n;
  }

  /** Slot i, below the length, made a hole: zero, `null` for a reference. */
  zero(i: usize): void {
    if (i >= this.len) trap(Trap.Bounds);
    this.clear(i, i + 1);
  }

  /** @tsl.inline */
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

  // SAFETY: the new block is ncap elements of the call arena, at least len; the first len are copied from the old one and
  // the rest zeroed, as the arena's memory is reused. The old block stays in the arena, which the caller resets whole, so
  // nothing reads it after: `data` is the new one. The arena traps 14 where it has no room left, so `next` is never 0.
  // R16: only `push`'s slow path and `reserve` grow (not the constructor): inlined into those, which are out of line.
  /** @tsl.inline */
  private grow(need: usize): void {
    const cap = this.cap;
    const dbl = cap + cap;
    const ncap = dbl < need ? need : dbl;
    const size = elemSize(this.elem);
    const bytes = ncap * size;
    const next = callRegionBytes(bytes);
    if (next === 0n) trap(Trap.OutOfMemory);
    const kept = this.len * size;
    if (this.data !== 0n) copyBytes(next, this.data, kept);
    bytesAt(next + toU64(kept), bytes - kept).fill(0);
    this.data = next;
    this.cap = ncap;
  }
}
