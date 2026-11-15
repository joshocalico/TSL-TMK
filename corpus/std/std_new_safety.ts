// What @tsl/std adds to @tsl/alloc, and each way it can be misused (SPEC 3.5, D43): stale references reaching closures, loans,
// and running out of memory in every form, under a small page limit, on the host and natively alike.
import { lit, toU32, toU64, u32, u64, u8, type bool, type usize } from "@tsl/core";
import { globalAllocator, ExactMap, ref, Set, Slab, Str, StrBuilder, Vec } from "@tsl/std";
import { limitPages, poolPages } from "./pool.ts";

/** @tsl.global-allocator */
export const heap = globalAllocator(poolPages);

class Thing {
  constructor(public v: u32) {}
}
const things = new Slab<Thing>();

function stale(): Thing {
  const t = things.add(new Thing(1));
  things.remove(t);
  return t;
}

// --- a stale reference reaching a closure: nothing checks a closure's parameter, so the library does.
export function staleReachesVecForEach(): u32 {
  const v = new Vec(ref<Thing>());
  v.push(stale());
  v.forEach(() => {});
  return 0;
}

export function staleReachesMapKeyForEach(): u32 {
  const m = new ExactMap(ref<Thing>(), u32);
  m.set(stale(), 1);
  m.forEach(() => {});
  return 0;
}

export function staleReachesMapValueForEach(): u32 {
  const m = new ExactMap(u32, ref<Thing>());
  m.set(1, stale());
  m.forEach(() => {});
  return 0;
}

export function staleReachesSetForEach(): u32 {
  const s = new Set(ref<Thing>());
  s.add(stale());
  s.forEach(() => {});
  return 0;
}

export function staleFromMapGet(): u32 {
  const m = new ExactMap(u32, ref<Thing>());
  m.set(1, stale());
  return m.get(1).v;
}

export function staleFromVecPop(): u32 {
  const v = new Vec(ref<Thing>());
  v.push(stale());
  return v.pop().v;
}

export function staleFromRemoveAt(): u32 {
  const v = new Vec(ref<Thing>());
  v.push(stale());
  return v.removeAt(0).v;
}

export function staleKeyByIdentityDoesntTrapToCompare(): bool {
  const t = stale();
  using s = new Set(ref<Thing>());
  s.add(t);
  return s.has(t) && s.delete(t) && !s.has(t);
}

export function liveReferencesPassAll(): u32 {
  const t = things.add(new Thing(5));
  using v = new Vec(ref<Thing>());
  using m = new ExactMap(ref<Thing>(), ref<Thing>());
  v.push(t);
  m.set(t, t);
  let s: u32 = 0;
  v.forEach((x) => {
    s += x.v;
  });
  m.forEach((k, x) => {
    s += k.v + x.v;
  });
  things.remove(t);
  return s;
}

// --- removal leaves nothing to read
export function afterPop(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.pop();
  return v.get(0);
}

export function afterRemoveAt(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.push(2);
  v.removeAt(0);
  return v.get(1);
}

export function afterSwapRemove(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.push(2);
  v.push(3);
  const out = v.swapRemove(0);
  return out * 10 + v.get(0);
}

export function afterSwapRemoveOfLast(): usize {
  using v = new Vec(u32);
  v.push(1);
  v.swapRemove(0);
  return v.length;
}

export function afterClear(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.clear();
  return v.get(0);
}

export function sliceAfterPopIsShorter(): usize {
  using v = new Vec(u32);
  v.push(1);
  v.push(2);
  v.pop();
  let n: usize = 0;
  v.withSlice((s) => {
    n = s.length;
  });
  return n;
}

export function insertAndOrder(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.push(3);
  v.insert(1, 2);
  v.insert(0, 0);
  v.insert(4, 4);
  return v.get(0) * 10000 + v.get(1) * 1000 + v.get(2) * 100 + v.get(3) * 10 + v.get(4);
}

export function insertPastEnd(): u32 {
  using v = new Vec(u32);
  v.insert(1, 2);
  return 0;
}

export function removeAtPastEnd(): u32 {
  using v = new Vec(u32);
  v.removeAt(0);
  return 0;
}

export function mapGetAfterDelete(): u32 {
  using m = new ExactMap(u32, u32);
  m.set(1, 2);
  m.delete(1);
  return m.get(1);
}

export function mapForEachSkipsDeleted(): u32 {
  using m = new ExactMap(u32, u32);
  for (let i: u32 = 0; i < 10; i++) m.set(i, i);
  m.delete(3);
  m.delete(0);
  m.set(0, 100);
  let last: u32 = 0;
  let count: u32 = 0;
  m.forEach((k, v) => {
    last = k + v;
    count++;
  });
  return last * 100 + count;
}

export function mapClearThenUse(): u32 {
  using m = new ExactMap(u32, u32);
  for (let i: u32 = 0; i < 100; i++) m.set(i, i);
  m.clear();
  const had = m.has(5);
  m.set(5, 6);
  return (had ? 1000 : 0) + m.get(5) + toU32(m.size);
}

export function useAfterFreeMap(): usize {
  const m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.free();
  return m.size === 1 ? toU32(m.get(1)) : 0;
}

export function doubleFreeMap(): u32 {
  const m = new ExactMap(u32, u32);
  m.free();
  m.free();
  return 0;
}

export function freeThenDisposeIsFine(): u32 {
  using v = new Vec(u32);
  using m = new ExactMap(u32, u32);
  using b = new StrBuilder();
  v.free();
  m.free();
  b.free();
  return 1;
}

export function useAfterFreeVec(): usize {
  const v = new Vec(u32);
  v.free();
  return v.length;
}

export function doubleFreeVec(): u32 {
  const v = new Vec(u32);
  v.free();
  v.free();
  return 0;
}

// --- loans
export function pushInForEach(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.forEach(() => {
    v.push(2);
  });
  return 0;
}

export function popInForEach(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.forEach(() => {
    v.pop();
  });
  return 0;
}

export function removeAtInForEach(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.forEach(() => {
    v.removeAt(0);
  });
  return 0;
}

export function clearInForEach(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.forEach(() => {
    v.clear();
  });
  return 0;
}

export function freeInForEach(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.forEach(() => {
    v.free();
  });
  return 0;
}

export function setInForEachIsFine(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.forEach((x, i) => {
    v.set(i, x + 1);
  });
  return v.get(0);
}

export function pushInWithSlice(): u32 {
  const v = new Vec(u32);
  v.push(1);
  v.withSlice(() => {
    v.push(2);
  });
  return 0;
}

export function insertInMapForEach(): u32 {
  const m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.forEach(() => {
    m.set(2, 2);
  });
  return 0;
}

export function deleteInMapForEach(): u32 {
  const m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.forEach((k) => {
    m.delete(k);
  });
  return 0;
}

export function clearInMapForEach(): u32 {
  const m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.forEach(() => {
    m.clear();
  });
  return 0;
}

export function freeInMapForEach(): u32 {
  const m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.forEach(() => {
    m.free();
  });
  return 0;
}

export function overwriteInMapForEachIsFine(): u32 {
  using m = new ExactMap(u32, u32);
  m.set(1, 1);
  m.forEach((k, v) => {
    m.set(k, v + 41);
  });
  return m.get(1);
}

/** A Set is JS's (D47): what's added during forEach is visited, so this sees 1 and then 2. */
export function addInSetForEach(): u32 {
  const s = new Set(u32);
  s.add(1);
  let seen: u32 = 0;
  s.forEach((k) => {
    seen = seen * 10 + k;
    s.add(2);
  });
  return seen;
}

export function freeStrInWithBytes(): u32 {
  const s = Str.of(lit("abc"));
  s.withBytes(() => {
    s.free();
  });
  return 0;
}

export function loanEndsWithTheCall(): u32 {
  using v = new Vec(u32);
  v.push(1);
  v.forEach(() => {});
  v.withSlice(() => {});
  v.push(2);
  return toU32(v.length);
}

// --- Str
export function staleStrStored(): usize {
  const h = new Vec(ref<Str>());
  const s = Str.of(lit("abc"));
  h.push(s);
  s.free();
  return h.get(0).length;
}

export function staleStrKey(): u32 {
  const m = new ExactMap(ref<Str>(), u32);
  const k = Str.of(lit("abc"));
  m.set(k, 1);
  k.free();
  const other = Str.of(lit("xyz"));
  m.set(other, 1);
  m.has(Str.of(lit("abc")));
  return 0;
}

export function doubleFreeStr(): u32 {
  const s = Str.of(lit("abc"));
  s.free();
  s.free();
  return 0;
}

export function strIsIndependentOfItsInput(): u32 {
  const b = new Vec(u8);
  b.push(97);
  let out: u32 = 0;
  b.withSlice((a) => {
    const s = Str.of(a);
    a[0] = 98;
    out = s.at(0);
    s.free();
  });
  return out;
}

export function strFreedBytesAreNotReadable(): u32 {
  const a = Str.of(lit("aaaaaaaaaaaaaaaa"));
  const h = new Vec(ref<Str>());
  h.push(a);
  a.free();
  const b = Str.of(lit("bbbbbbbbbbbbbbbb"));
  const r = h.get(0).at(0); // the slot is b's now, and a's reference traps 5
  b.free();
  return r;
}

// --- running out, in each form, from a limit of pages this program sets
export function runsOutVec(): u32 {
  limitPages(0);
  const v = new Vec(u32);
  for (let i: u32 = 0; i < 100000000; i++) v.push(i);
  return 0;
}

export function runsOutInsert(): u32 {
  limitPages(0);
  const v = new Vec(u32);
  for (let i: u32 = 0; i < 100000000; i++) v.insert(0, i);
  return 0;
}

export function runsOutMap(): u32 {
  limitPages(0);
  const m = new ExactMap(u32, u32);
  for (let i: u32 = 0; i < 100000000; i++) m.set(i, i);
  return 0;
}

export function runsOutSet(): u32 {
  limitPages(0);
  const s = new Set(u32);
  for (let i: u32 = 0; i < 100000000; i++) s.add(i);
  return 0;
}

export function runsOutStr(): u32 {
  limitPages(0);
  for (let i: u32 = 0; i < 100000000; i++) Str.of(lit("abcdefgh"));
  return 0;
}

export function runsOutBuilder(): u32 {
  limitPages(0);
  const b = new StrBuilder();
  for (let i: u32 = 0; i < 1000000000; i++) b.appendByte(1);
  return 0;
}

export function runsOutConcat(): u32 {
  limitPages(0);
  let s = Str.of(lit("abcdefgh"));
  for (let i: u32 = 0; i < 64; i++) s = s.concat(s);
  return 0;
}

export function runsOutSlice(): u32 {
  limitPages(0);
  const s = Str.of(lit("abcdefgh"));
  for (let i: u32 = 0; i < 100000000; i++) s.slice(0, 8);
  return 0;
}

export function tryPushHolds(): bool {
  limitPages(1);
  using v = new Vec(u32);
  let n: u32 = 0;
  while (v.tryPush(n)) n++;
  for (let i: u32 = 0; i < n; i++) if (v.get(i) !== i) return false;
  return toU32(v.length) === n && !v.tryPush(0);
}

export function trySetHolds(): bool {
  limitPages(1);
  using m = new ExactMap(u32, u32);
  let n: u32 = 0;
  while (m.trySet(n, n + 1)) n++;
  const before = toU32(m.size);
  if (m.trySet(n, 0)) return false;
  m.set(0, 77); // overwriting needs no memory
  for (let i: u32 = 1; i < n; i++) if (m.get(i) !== i + 1) return false;
  return before === n && m.get(0) === 77 && !m.has(n);
}

// Whichever vector runs out first, heads, keys, values or chain, the Map stays as it was. Which one it is depends on what's free,
// so this tries every small limit, with values larger than keys and then keys larger than values.
function holdsWhenItFails(limit: usize): bool {
  limitPages(limit);
  const m = new ExactMap(u32, u64);
  let n: u32 = 0;
  while (m.trySet(n, 7n)) n++;
  let seen: u32 = 0;
  m.forEach((k, v) => {
    if (k === seen && v === 7n) seen++;
  });
  const ok = seen === n && toU32(m.size) === n && !m.has(n);
  m.free();
  return ok;
}

export function trySetFailsPartWay(): bool {
  for (let limit: usize = 0; limit < 40; limit++) {
    if (!holdsWhenItFails(limit)) return false;
  }
  return true;
}

function holdsWhenKeysFail(limit: usize): bool {
  limitPages(limit);
  const m = new ExactMap(u64, u8);
  let n: u32 = 0;
  while (m.trySet(toU64(n), 1)) n++;
  let seen: u32 = 0;
  m.forEach(() => {
    seen++;
  });
  const ok = seen === n && toU32(m.size) === n;
  m.free();
  return ok;
}

export function trySetFailsPartWayKeys(): bool {
  for (let limit: usize = 0; limit < 40; limit++) {
    if (!holdsWhenKeysFail(limit)) return false;
  }
  return true;
}

// A Str that's freed gives its slot back, as well as its bytes: this goes on for longer than slots last, under a limit.
export function strSlotsComeBack(): bool {
  limitPages(16);
  for (let i: u32 = 0; i < 100000; i++) {
    const s = Str.of(lit("abcdefgh"));
    s.free();
  }
  return true;
}

export function tryAddSetHolds(): bool {
  limitPages(1);
  using s = new Set(u32);
  let n: u32 = 0;
  while (s.tryAdd(n)) n++;
  s.add(0); // already there, so it needs no memory
  return toU32(s.size) === n && s.has(0) && !s.has(n);
}

export function tryStrHolds(): bool {
  limitPages(1);
  for (let i: u32 = 0; i < 100000000; i++) {
    if (Str.tryOf(lit("a string of about thirty bytes.")) === null) return true;
  }
  return false;
}

export function tryAppendBytesHolds(): bool {
  limitPages(1);
  using b = new StrBuilder();
  for (let i: u32 = 0; i < 100000000; i++) {
    if (!b.tryAppendBytes(lit("0123456789"))) return b.length > 0;
  }
  return false;
}
