// file: ex-slab.ts
import { toU64, Trap, trap, u32, u64, type bool, type usize } from "@tsl/core";
import { elemSize, genOf, inlineOf, objectAt, placeObject, ptrAt, retireObject, slotOf, type Elem } from "@tsl/unsafe";
import type { Heap } from "./ex-heap.ts";

const CHUNK_HEADER: usize = 16; // [next chunk: u64][pad]
const SLOT_PREFIX: usize = 16; //  [next free slot: u64][generation: u32][owner: u32], then the object.
const GEN_AT: u64 = 8n; //         an odd generation means occupied
const OWNER_AT: u64 = 12n;
const MAX_GEN: u32 = 0xfffe; //    stored references keep 16 bits of generation

let nextOwner: u32 = 1; // a Slab takes its ID when it first grows, so one that never has owns nothing

/** Chunks come from a Heap and never go back while the Slab lives, so a slot only ever holds a T. */
export class Slab<T extends object> {
  private chunks: u64 = 0n;
  private freeList: u64 = 0n;
  private count: usize = 0;
  private owner: u32 = 0;
  private elem: Elem<T> = inlineOf<T>();

  constructor(private heap: Heap, private chunkSlots: usize) {}

  get size(): usize {
    return this.count;
  }

  private stride(): usize {
    return SLOT_PREFIX + elemSize(this.elem);
  }

  private slotIn(chunk: u64, i: usize): u64 {
    return chunk + toU64(CHUNK_HEADER + i * this.stride());
  }

  // SAFETY: chunk is a fresh block big enough for its header and chunkSlots slots.
  private grow(): bool {
    const chunk = this.heap.allocBytes(CHUNK_HEADER + this.chunkSlots * this.stride());
    if (chunk === 0n) return false;
    if (this.owner === 0) this.owner = nextOwner++;
    ptrAt(u64, chunk).write(this.chunks);
    this.chunks = chunk;
    for (let i = this.chunkSlots; i > 0; i--) {
      const slot = this.slotIn(chunk, i - 1);
      ptrAt(u64, slot).write(this.freeList); // a free slot's link stays out of its object's bytes
      ptrAt(u32, slot + GEN_AT).write(0);
      ptrAt(u32, slot + OWNER_AT).write(this.owner);
      this.freeList = slot;
    }
    return true;
  }

  /** @tsl.moves item */
  // SAFETY: slot came off the free list, so it's in a live chunk, unoccupied, and only ever holds a T.
  add(item: T): T | null {
    if (this.freeList === 0n && !this.grow()) return null;
    const slot = this.freeList;
    this.freeList = ptrAt(u64, slot).read();
    const gen = ptrAt(u32, slot + GEN_AT).read() + 1;
    ptrAt(u32, slot + GEN_AT).write(gen);
    this.count++;
    return placeObject(slot, gen, item);
  }

  /** Traps with code 5 if the item isn't in this Slab, or has already been removed. */
  // SAFETY: slotOf and genOf only accept a slot's own reference, and the owner and generation checks reject the rest.
  remove(item: T): void {
    const slot = slotOf(item);
    const gen = genOf(item);
    if (ptrAt(u32, slot + OWNER_AT).read() !== this.owner) trap(Trap.Stale);
    if (ptrAt(u32, slot + GEN_AT).read() !== gen) trap(Trap.Stale);
    ptrAt(u32, slot + GEN_AT).write(gen + 1); // now even, so every stored reference is stale
    retireObject(item);
    this.count--;
    if (gen + 1 >= MAX_GEN) return; // out of generations: the slot is never reused
    ptrAt(u64, slot).write(this.freeList);
    this.freeList = slot;
  }

  /** Visits occupied slots. Removing the visited object during the call is allowed. */
  // SAFETY: chunks never go back to the Heap while the Slab lives, and an odd generation means the slot holds a T.
  forEach(f: (item: T) => void): void {
    for (let chunk = this.chunks; chunk !== 0n; chunk = ptrAt(u64, chunk).read()) {
      for (let i = 0; i < this.chunkSlots; i++) {
        const slot = this.slotIn(chunk, i);
        if ((ptrAt(u32, slot + GEN_AT).read() & 1) === 1) f(objectAt<T>(slot));
      }
    }
  }
}
