// file: ex-std-global.ts
import { Heap, type PageSource } from "@tsl/alloc";
import { idiv, toU64, toUsize, u64, type bool, type u32, type usize } from "@tsl/core";
import { bytesAt, onPageRunFreed, ptrAt, sourcePages } from "@tsl/unsafe";

export { checkLive, keyHash, keySame, ref, type ElemOf } from "@tsl/unsafe";

// SAFETY: the environment registered this source (setPageSource), and it's trusted to return what it promises (3.8).
function registered(pages: usize): u64 {
  return sourcePages(pages);
}

class Source {
  constructor(public from: PageSource) {}
}

// tslc builds this over the program's named source, if it has one, and nothing changes it at run time natively.
const source = new Source(registered);

const PAGE_BYTES: usize = 4096;
const RUN_LISTS: usize = 24; // by the log of the size, as a Heap keeps nothing about a run itself
const runs = new BigUint64Array(24);

function listOf(n: usize): usize {
  let list: usize = 0;
  for (let s = n; s > 1; s = idiv(s, 2)) list++;
  return list;
}

/** A run of whole pages a Heap was given back. `@tsl/alloc`'s Heap keeps none, as a kernel doesn't need it to; a program does. */
// SAFETY: its owner gave it back, so nothing else has it, and every run is at least one page, so its two words fit.
function keepRun(addr: u64, n: usize): void {
  const list = listOf(n);
  ptrAt(u64, addr).write(runs[list]!);
  ptrAt(u64, addr + 8n).write(toU64(n));
  runs[list] = addr;
}

// SAFETY: the run came off a list, and a list only holds what keepRun was given: it's ours, and it's zeroed as a source's is.
function takeRun(n: usize): u64 {
  for (let list = listOf(n); list < RUN_LISTS; list++) {
    let before: u64 = 0n;
    for (let at = runs[list]!; at !== 0n; at = ptrAt(u64, at).read()) {
      const size = toUsize(ptrAt(u64, at + 8n).read());
      if (size >= n) {
        const next = ptrAt(u64, at).read();
        if (before === 0n) runs[list] = next;
        else ptrAt(u64, before).write(next);
        if (size > n) keepRun(at + toU64(n * PAGE_BYTES), size - n);
        bytesAt(at, n * PAGE_BYTES).fill(0);
        return at;
      }
      before = at;
    }
  }
  return 0n;
}

// SAFETY: tslc binds this at compile time, and it's only the two functions above.
export const keepsRuns: bool = onPageRunFreed(keepRun);

function pages(n: usize): u64 {
  const run = takeRun(n);
  if (run !== 0n) return run;
  const from = source.from;
  return from(n);
}

/** The global allocator: one Heap, per thread in concept (D40), over the named page source or else the registered one. */
export const heap = new Heap(pages);

/**
 * Names the program's page source for the global allocator: a top-level `const h = globalAllocator(f)` with the tag
 * above it (3.5), at most one in a program (TSL1020, TSL1021). tslc reads it at compile time, and on V8 and JSC it runs
 * as the module loads, before any exported function can allocate.
 */
export function globalAllocator(named: PageSource): Heap {
  source.from = named;
  return heap;
}

let key0: u32 = 0x243f6a88;
let key1: u32 = 0x85a308d3;

export function hashKeyWord(i: u32): u32 {
  return i === 0 ? key0 : key1;
}

/** No guest has entropy of its own, so a program facing untrusted keys registers some, before it inserts anything (D42). */
export function setHashKey(k0: u32, k1: u32): void {
  key0 = k0;
  key1 = k1;
}

/** A keyed MurmurHash3 finaliser. A hash can depend on an address, and so nothing visible depends on a hash. */
export function mix(x: u32): u32 {
  let h = x ^ key0;
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h = h ^ key1 ^ (h >>> 13);
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
