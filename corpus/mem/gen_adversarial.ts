// Attacks on the generation scheme (SPEC 3.5), and the places native and the host are allowed to differ (3.10).
import { Heap, Slab } from "@tsl/alloc";
import { toU64, u32, type u32 as U32, type u64 as U64 } from "@tsl/core";
import { genOf, objectAt, placeObject, ptrAt, slotOf } from "@tsl/unsafe";
import { pages } from "./pages.ts";

const heap = new Heap(pages);

class Pair {
  constructor(
    public first: U64,
    public second: U64,
  ) {}
}
class Node {
  next: Node | null = null;
  val: U64 = 0n;
  constructor(v: U64) {
    this.val = v;
  }
}
class Word {
  constructor(public w: U64) {}
}

const pairs = new Slab<Pair>(heap, 4);

// Allowed divergence 5: a local read after remove. V8 traps with code 5. Natively it reads old, well-typed data.
export function staleLocalRead(): U64 {
  const t = pairs.add(new Pair(1n, 22n))!;
  pairs.remove(t);
  return t.second;
}

export function staleLocalInForEach(): U64 {
  const s = new Slab<Pair>(heap, 4);
  s.add(new Pair(1n, 33n));
  let got: U64 = 0n;
  s.forEach((p) => {
    s.remove(p);
    got = p.second;
  });
  return got;
}

// A stale write through a local lands in whatever now occupies the slot: well-typed, but not harmless.
export function staleLocalWriteHitsNewOccupant(): U64 {
  const s = new Slab<Pair>(heap, 1);
  const a = s.add(new Pair(1n, 2n))!;
  s.remove(a);
  const b = s.add(new Pair(3n, 4n))!;
  a.second = 99n;
  return b.second;
}

// A free slot's link is in its prefix, so a stale read of a first field is that field's old value, never an address
// (SPEC 3.8), even with other slots free around it.
export function staleFirstFieldIsOldDataNotAnAddress(): U64 {
  const s = new Slab<Word>(heap, 4);
  const a = s.add(new Word(5n))!;
  const b = s.add(new Word(6n))!;
  s.remove(b);
  s.remove(a);
  return a.w;
}

// A stale first field holding a reference still gives back that reference, and its generation check still fires.
export function staleFirstFieldReferenceIsChecked(): U64 {
  const s = new Slab<Node>(heap, 4);
  const a = s.add(new Node(1n))!;
  const b = s.add(new Node(2n))!;
  a.next = b;
  s.remove(b);
  s.remove(a);
  return a.next!.val;
}

class Holder {
  r: Pair | null = null;
}

// SAFETY: a slot this test owns. It plays a library that doesn't retire slots, against the spec's rule.
function placeAtGen(slot: U64, gen: U32, p: Pair): Pair {
  ptrAt(u32, slot + 8n).write(gen);
  return placeObject(slot, gen, p);
}

// Generations are only 16 bits in a reference. A slot that isn't retired wraps, and an old reference then passes:
// that's why Slab retires at 0xfffe. This library doesn't, so this shows what the retirement is buying.
// SAFETY: writes a slot in this test's own block.
export function wrappedGenerationAliases(): U64 {
  const slot = heap.allocBytes(64);
  const h = new Holder();
  h.r = placeAtGen(slot, 1, new Pair(10n, 11n));
  placeAtGen(slot, 1 + 65536, new Pair(20n, 21n));
  return h.r.second;
}

// The word before the object is the check, so forging a generation needs unsafe code.
// SAFETY: writes the prefix of a slot this test owns.
export function bumpedGenerationTraps(): U64 {
  const slot = heap.allocBytes(64);
  const h = new Holder();
  h.r = placeAtGen(slot, 1, new Pair(10n, 11n));
  ptrAt(u32, slot + 8n).write(3);
  return h.r.second;
}

// SAFETY: a slot this test owns: objectAt reads its current generation, so the new reference is live.
export function objectAtGivesLiveReference(): U64 {
  const slot = heap.allocBytes(64);
  const p = placeAtGen(slot, 1, new Pair(10n, 11n));
  const h = new Holder();
  h.r = objectAt<Pair>(slot);
  return h.r.second + toU64(genOf(p)) * 100n + (slotOf(p) === slot ? 1000n : 0n);
}

// An object can only be removed from the slab it's in, with the host and native code agreeing (SPEC 3.5).
export function crossSlabRemoveTraps(): U64 {
  const a = new Slab<Pair>(heap, 2);
  const b = new Slab<Pair>(heap, 2);
  const x = a.add(new Pair(1n, 2n))!;
  b.add(new Pair(5n, 6n));
  b.remove(x);
  return 0n;
}

// The count underflow this used to reach: b is empty, and native code would have trapped 1 where V8 went on.
export function crossSlabRemoveFromEmptyTraps(): U64 {
  const a = new Slab<Pair>(heap, 2);
  const b = new Slab<Pair>(heap, 2);
  b.remove(a.add(new Pair(1n, 2n))!);
  return 0n;
}

export function removeFromItsOwnSlabWorks(): U64 {
  const a = new Slab<Pair>(heap, 2);
  const x = a.add(new Pair(1n, 2n))!;
  a.remove(x);
  return toU64(a.size);
}
