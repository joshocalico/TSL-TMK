// file: ex-std-slab.ts
import { Slab as AllocSlab } from "@tsl/alloc";
import { Trap, trap, type usize } from "@tsl/core";
import { heap } from "./ex-std-global.ts";

const CHUNK_SLOTS: usize = 32;

/** Where an object lives in `strict` if it has to outlive a call: `@tsl/alloc`'s Slab over the global allocator. */
export class Slab<T extends object> {
  private s: AllocSlab<T> = new AllocSlab<T>(heap, CHUNK_SLOTS);

  get size(): usize {
    return this.s.size;
  }

  /** @tsl.moves item */
  add(item: T): T {
    const placed = this.s.add(item);
    if (placed === null) trap(Trap.OutOfMemory);
    return placed;
  }

  /** @tsl.moves item */
  tryAdd(item: T): T | null {
    return this.s.add(item);
  }

  /** Every stored reference to it traps 5 from now on. Traps 5 if it isn't in this Slab. */
  remove(item: T): void {
    this.s.remove(item);
  }

  forEach(f: (item: T) => void): void {
    this.s.forEach(f);
  }
}
