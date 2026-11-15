// Slab from safe code: growth, slot reuse, forEach with removal, and stale references (SPEC 3.5).
import { Heap, Slab, Vec, ref } from "@tsl/alloc";
import { toU32, toU64, type bool, type u32, type u64, type usize } from "@tsl/core";
import { limitPages, pages, pagesUsed } from "./pages.ts";

const heap = new Heap(pages);

export class Domain {
  constructor(public id: u32) {}
}

export class Timer {
  owner: Domain | null = null;
  constructor(public deadline: u64) {}
  expired(now: u64): bool {
    return now >= this.deadline;
  }
}

const domains = new Slab<Domain>(heap, 4);
const timers = new Slab<Timer>(heap, 4);

export function growsPastAChunk(n: usize): u32 {
  const owner = domains.add(new Domain(7))!;
  const local = new Slab<Timer>(heap, 4);
  let last: Timer | null = null;
  for (let i = 0; i < n; i++) {
    const t = local.add(new Timer(toU64(i)))!;
    t.owner = owner;
    last = t;
  }
  return toU32(local.size) * 1000 + toU32(last!.deadline) * 10 + last!.owner!.id;
}

export function forEachVisitsAll(n: usize): u64 {
  const local = new Slab<Timer>(heap, 3);
  for (let i = 0; i < n; i++) local.add(new Timer(toU64(i)));
  let sum: u64 = 0n;
  local.forEach((t) => {
    sum += t.deadline;
  });
  return sum;
}

export function removalDuringForEach(n: usize): u32 {
  const local = new Slab<Timer>(heap, 3);
  for (let i = 0; i < n; i++) local.add(new Timer(toU64(i)));
  let visited: u32 = 0;
  local.forEach((t) => {
    visited++;
    if (t.deadline % 2n === 0n) local.remove(t);
  });
  let left: u32 = 0;
  local.forEach((_t) => {
    left++;
  });
  return visited * 1000 + left + toU32(local.size) * 1000000;
}

export function slotReuse(): bool {
  const local = new Slab<Domain>(heap, 2);
  const a = local.add(new Domain(1))!;
  local.add(new Domain(2));
  const used = pagesUsed();
  local.remove(a);
  const b = local.add(new Domain(3))!;
  // The slot came back, no new memory was taken, and it's a different object to JS and to the generation.
  return b !== a && b.id === 3 && pagesUsed() === used && local.size === 2;
}

export function removedTwice(): u32 {
  const local = new Slab<Domain>(heap, 2);
  const a = local.add(new Domain(1))!;
  local.remove(a);
  local.remove(a);
  return 0;
}

export function removeStaleThenReused(): u32 {
  const local = new Slab<Domain>(heap, 1);
  const a = local.add(new Domain(1))!;
  local.remove(a);
  local.add(new Domain(2));
  local.remove(a); // the slot is occupied again, by another generation
  return 0;
}

export function removeStackObject(): u32 {
  const local = new Slab<Domain>(heap, 1);
  local.remove(new Domain(1));
  return 0;
}

class Holder {
  timer: Timer | null = null;
}

const held = new Slab<Holder>(heap, 2);

function holding(): Holder {
  const h = held.add(new Holder())!;
  h.timer = timers.add(new Timer(5n));
  return h;
}

export function storedLive(): u64 {
  return holding().timer!.deadline;
}

export function storedStale(): u64 {
  const h = holding();
  timers.remove(h.timer!);
  return h.timer!.deadline;
}

export function storedStaleThroughLocal(): u64 {
  const h = holding();
  timers.remove(h.timer!);
  const t = h.timer!; // no trap: this doesn't dereference it
  return t.deadline;
}

export function storedStaleWrite(): u32 {
  const h = holding();
  timers.remove(h.timer!);
  h.timer!.deadline = 9n;
  return 0;
}

export function storedStaleCall(): bool {
  const h = holding();
  timers.remove(h.timer!);
  return h.timer!.expired(1n);
}

export function comparingStaleDoesntTrap(): bool {
  const h = holding();
  const t = h.timer!;
  timers.remove(t);
  return h.timer !== null && h.timer === t;
}

export function staleInAStackObject(): u64 {
  const h = new Holder();
  h.timer = timers.add(new Timer(5n));
  timers.remove(h.timer!);
  return h.timer!.deadline;
}

export function staleAfterReuse(): u64 {
  const local = new Slab<Timer>(heap, 1);
  const h = held.add(new Holder())!;
  h.timer = local.add(new Timer(1n));
  local.remove(h.timer!);
  local.add(new Timer(2n)); // the same slot, with a new generation
  return h.timer!.deadline;
}

export function staleThroughAVec(): u64 {
  using v = new Vec(ref<Timer>(), heap);
  const t = timers.add(new Timer(5n))!;
  v.push(t);
  timers.remove(t);
  return v.get(0).deadline;
}

export function vecComparisonDoesntTrap(): bool {
  using v = new Vec(ref<Timer>(), heap);
  const t = timers.add(new Timer(5n))!;
  v.push(t);
  timers.remove(t);
  return v.get(0) === t;
}

const statics = new Holder();
const fixed = new Timer(77n);

export function staticsAreLive(): u64 {
  statics.timer = fixed;
  return statics.timer!.deadline;
}

export function staticIsntRemovable(): u32 {
  timers.remove(fixed);
  return 0;
}

function cycle(s: Slab<Domain>, n: usize): void {
  for (let i: usize = 0; i < n; i++) {
    s.remove(s.add(new Domain(1))!);
  }
}

export function generationsRetireSlots(): bool {
  // One slot per chunk: when it runs out of generations it's never reused, so the next add takes a new chunk.
  const s = new Slab<Domain>(heap, 1);
  const a = s.add(new Domain(1))!;
  s.remove(a);
  const before = countChunks(s);
  cycle(s, 32766);
  const near = countChunks(s);
  cycle(s, 1);
  const after = countChunks(s);
  return before === 1 && near <= 2 && after >= near && s.size === 0;
}

function countChunks(s: Slab<Domain>): usize {
  const b = s.add(new Domain(2))!;
  let n: usize = 0;
  s.forEach((_d) => {
    n++;
  });
  s.remove(b);
  return n;
}

export function exhaustedSlotsStayStale(): u64 {
  const s = new Slab<Timer>(heap, 1);
  const h = held.add(new Holder())!;
  h.timer = s.add(new Timer(3n));
  s.remove(h.timer!);
  for (let i: usize = 0; i < 40000; i++) s.remove(s.add(new Timer(4n))!);
  return h.timer!.deadline;
}

export function outOfMemoryIsNull(): bool {
  limitPages(0);
  const starving = new Slab<Domain>(hungry, 4);
  return starving.add(new Domain(1)) === null;
}
const hungry = new Heap(pages);
