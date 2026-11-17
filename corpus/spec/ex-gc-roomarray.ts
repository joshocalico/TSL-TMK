// file: ex-gc-roomarray.ts
import { idiv, toU64, Trap, trap, u16, u32, u64, u8, type bool, type usize } from "@tsl/core";
import { copyBytes, elemSize, ptrAt, tailAddr, type ElemOf, type Ptr } from "@tsl/unsafe";
import { roomAddr, roomDrop, roomMake, type Counted, type Room } from "./ex-gc-rc.ts";

/**
 * A JS array of T as a lowered `rc` package holds it (R3, D66, D69): `JsArray`'s rules, with its elements in the counted
 * heap. Its first room is its holder's tail, so a holder and the elements that fit are one counted allocation; past that,
 * each room is a `Room`, doubling as it fills, and the one outgrown is let go of. Its holder is made by
 * `withTail(n, new Holder(length))` and then gives it its tail (`attach`), which a constructor can't read. Freeing is
 * its holder's: the elements, a step each, then its room if it has one of its own (`rooms`, `trim`).
 */
export class JsRoomArray<T> {
  private data: u64 = 0n;
  private len: usize = 0;
  private cap: usize = 0;
  private room: Counted<Room> | null = null;

  /**
   * `length` elements, each zero once its holder's tail is attached: JS's `new Array(length)`, or `[]`. `holes` says a
   * slot past the length can be read again as a hole, so a shorter length zeroes what it drops: an array of references.
   * A lowered array of numbers can't have a hole (it traps 15 first), so its dropped slots are left as they are.
   */
  constructor(
    private elem: ElemOf<T>,
    length: usize,
    private holes: bool,
  ) {
    this.len = length;
  }

  /** The first room: `holder`'s tail of n elements, zeroed, which this array is in place in. At least its length. */
  // SAFETY: the holder was just made with a tail of n of this array's elements (its element's size), which lives as long
  // as the holder, and this array, in place in it, never outlives it.
  attach<H extends object>(holder: H, n: usize): void {
    if (n < this.len) trap(Trap.Bounds);
    this.data = tailAddr(holder);
    this.cap = n;
  }

  /** @tsl.inline */
  get length(): usize {
    return this.len;
  }

  /** The room the array has, in elements. */
  /** @tsl.inline */
  get capacity(): usize {
    return this.cap;
  }

  /** How many rooms of its own the array holds, 0 or 1: what its holder's freeing gives back after the elements. */
  /** @tsl.inline */
  get rooms(): usize {
    return this.room !== null ? 1 : 0;
  }

  /** @tsl.inline */
  // SAFETY: i is at most cap, so the address is in the room or just past it: an element step, with nothing to check.
  private slot(i: usize): Ptr<T> {
    return ptrAt(this.elem, this.data).add(i);
  }

  /** @tsl.inline */
  private at(i: usize): u64 {
    return this.slot(i).addr;
  }

  /** `a[i]`; past the end traps 2: a hole reads as zero, `null` for a reference. */
  /** @tsl.inline */
  // SAFETY: i is below len, so its slot is in the room.
  get(i: usize): T {
    if (i >= this.len) trap(Trap.Bounds);
    return this.slot(i).read();
  }

  /** `a[i] = v` below the length. */
  /** @tsl.inline */
  // SAFETY: i is below len, so its slot is in the room.
  set(i: usize, v: T): T {
    if (i >= this.len) trap(Trap.Bounds);
    this.slot(i).write(v);
    return v;
  }

  /**
   * Appends v and gives the new length, as JS's `push` does. R17: inlined at every level that inlines, as JsArray's is
   * (R16): with room left, a store and the length raised; full, `pushGrow`, out of line.
   */
  /** @tsl.inline */
  // SAFETY: n is below cap, so the slot at n is in the room.
  push(v: T): usize {
    const n = this.len;
    if (n >= this.cap) return this.pushGrow(v);
    this.slot(n).write(v);
    const m = n + 1;
    this.len = m;
    return m;
  }

  /** `push` on a full array: a room twice as big (`grow`), then the store. Out of line, so `push` stays small. */
  /** @tsl.noinline */
  // SAFETY: grow left room for one more, so the slot at len is in the room.
  private pushGrow(v: T): usize {
    const n = this.len;
    this.grow(n + 1);
    this.slot(n).write(v);
    const m = n + 1;
    this.len = m;
    return m;
  }

  /** The last element, removed; on an empty array, `none`. */
  // SAFETY: n is above zero, so the slot at n - 1 is in the room.
  pop(none: T): T {
    const n = this.len;
    if (n === 0) return none;
    const v = this.slot(n - 1).read();
    this.setLength(n - 1);
    return v;
  }

  /** The first element, removed, with every other moved down one; on an empty array, `none`. */
  // SAFETY: n is above zero, so slots 0 to n - 1 are in the room, and the copy moves n - 1 of them down one.
  shift(none: T): T {
    const n = this.len;
    if (n === 0) return none;
    const v = this.slot(0).read();
    copyBytes(this.at(0), this.at(1), (n - 1) * elemSize(this.elem));
    this.setLength(n - 1);
    return v;
  }

  /** Room for `n` elements without moving them again. */
  reserve(n: usize): void {
    if (n > this.cap) this.grow(n);
  }

  /**
   * JS's `a.length = n` within what's reserved: shorter zeroes what it drops (`holes`), longer adds holes. Gives n. R17:
   * inlined, as JsArray's is, and shorter tested first, which needs no test of the room, as the length is never above it:
   * so the lowering's pop (the length one less, once it's above zero) is that test, and with holes, one slot zeroed. And
   * with no holes, a longer length zeroes what it adds, as nothing kept those slots zero (a shorter length left them, and
   * growth zeroes nothing past what it copies): each slot below the length reads what was written there, or zero.
   */
  /** @tsl.inline */
  setLength(n: usize): usize {
    const len = this.len;
    if (n < len) {
      if (this.holes) this.clear(n, len);
    } else {
      if (n > this.cap) trap(Trap.Bounds);
      // with no holes, what's past the length wasn't kept zero, so a longer length zeroes what it adds (R17)
      if (!this.holes) this.clear(len, n);
    }
    this.len = n;
    return n;
  }

  /**
   * The room of its own let go of, and the array left empty: true if it had one. The last step of freeing its holder,
   * after its counted elements have been visited; the holder's tail goes with the holder.
   */
  trim(): bool {
    const r = this.room;
    this.len = 0;
    this.data = 0n;
    this.cap = 0;
    if (r === null) return false;
    this.room = null;
    roomDrop(r);
    return true;
  }

  /** Slot i, below the length, made a hole. */
  zero(i: usize): void {
    if (i >= this.len) trap(Trap.Bounds);
    this.clear(i, i + 1);
  }

  /** Calls f on each element and its index, in order, up to the length when it started; f mustn't change the length. */
  forEach(f: (x: T, i: usize) => void): void {
    const n = this.len;
    for (let i: usize = 0; i < n; i++) f(this.get(i), i);
  }

  /** @tsl.inline */
  // SAFETY: the slots from `from` to `to` are below cap, so these are the room's, a whole element at a time; an element's
  // size is a constant, so one arm is left.
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

  // SAFETY: the new room holds ncap elements, at least len; the first len are copied from the old one, which is let go of
  // if it's a room of its own (the holder's tail goes with the holder). Only what can be read as a hole is zeroed (R4):
  // in an array of references, the words past the ones the copy writes whole, so a slot a longer length reaches reads
  // `null`; an array of numbers has no holes (the lowering traps 15 first, and a shorter length leaves its slots as they
  // are already), so nothing in it is. Rare, so out of line: push stays small.
  /** @tsl.noinline */
  private grow(need: usize): void {
    const dbl = this.cap * 2;
    const ncap = dbl < need ? need : dbl;
    const size = elemSize(this.elem);
    const words = idiv(ncap * size + 7, 8);
    const next = roomMake(words, this.holes ? idiv(this.len * size, 8) : words);
    const at = roomAddr(next);
    copyBytes(at, this.data, this.len * size);
    const old = this.room;
    this.room = next;
    this.data = at;
    this.cap = ncap;
    if (old !== null) roomDrop(old);
  }
}
