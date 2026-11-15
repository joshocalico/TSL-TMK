// Written by tools/r7-pins.ts --write: each pin R7 moved (SPEC M5's R7 record), by pin file and key, with the change that
// moved it and, for -O1's loop bounds proof, how many checks the build's optimiser removed. maps-tirhash.json and
// pipe-tirhash.json are pinned again instead.

/** What each of R7's changes is, by the name tools/r7-pins.ts's stages give it. */
export const R7_WHY: Record<string, string> = {
  loopbounds:
    "-O1 removes a bounds check its loop's own test proves (R7: loopbounds.ts): an index the loop variable is, or widens, compared below the same length",
  optfields:
    "an optional number or boolean field printed as a bool flag field then its value field (R7, D62's first ruling), so auto prints with classes what stopped at it",
  arrfields:
    "a typed-array field printed as a runtime class of its pointer and length held in place, and a typed array's pointer read for an element (R7, D62's first ruling), so auto prints with classes what stopped at it",
  mapscross:
    "a Map or Set crossing an export printed as JsMap or JsSet with D36's surface exports (R7, D72)",
};

export const R7_MOVED: Record<string, [string, string?]> = {
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/class_struct.ts@leak": ["arrfields"],
  "corpus/memory/modes-tirhash.json#corpus/lower/pos/class_struct.ts@manual": ["arrfields"],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@leak@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@manual@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/memory/store_closure.ts@rc@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@leak@O1": ["arrfields"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@leak@O2": ["arrfields"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@manual@O1": ["arrfields"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@manual@O2": ["arrfields"],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@leak@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@manual@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@rc+check@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@rc+off@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@rc@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/floor_div.ts@strict@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@leak@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@manual@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc+check@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc+off@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@rc@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/wrap_forms.ts@strict@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@leak@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/cyc_interleave.ts@manual@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@leak@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@manual@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc+off@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/lower/strmap/app_graph.ts@rc@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/adler32.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/crc32_table.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/fnv1a.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/matmul_f64.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/rle.ts@O1": ["loopbounds", "1 checks removed at -O1"],
  "corpus/memory/opt-tirhash.json#corpus/pos/sha256_u32.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/sieve_u8.ts@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/pos/sort_i32.ts@O1": [
    "loopbounds",
    "2 checks removed at -O1",
  ],
  "corpus/memory/opt-tirhash.json#corpus/spec/run_memory.ts@O1": [
    "loopbounds",
    "1 checks removed at -O1",
  ],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/class_struct.ts@leak": ["arrfields"],
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/class_struct.ts@manual": ["arrfields"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/class_struct.ts@leak": ["arrfields"],
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/class_struct.ts@manual": ["arrfields"],
};

/** A pin R7 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r7Moved = (k: string): boolean =>
  Object.keys(R7_MOVED).some((x) => x.endsWith(`#${k}`));
