// Written by tools/clsid-pins.ts --write: each -O1 and -O2 pin that marking class ids' loads invariant moved (D73, SPEC
// 3.4's "Class ids don't change", M5's class-id record), by its key. Nothing at -O0 moves.
export const CLSID_WHY =
  "class ids' loads marked invariant (D73): load.T.inv in its -O1 or -O2 TIR, shared or moved across what can't change one";

export const CLSID_MOVED: ReadonlySet<string> = new Set([
  "corpus/lower/fallback/escape_global.ts@leak@O1",
  "corpus/lower/fallback/escape_global.ts@leak@O2",
  "corpus/lower/fallback/escape_global.ts@manual@O1",
  "corpus/lower/fallback/escape_global.ts@manual@O2",
  "corpus/lower/fallback/throw_value.ts@leak@O1",
  "corpus/lower/fallback/throw_value.ts@leak@O2",
  "corpus/lower/fallback/throw_value.ts@manual@O1",
  "corpus/lower/fallback/throw_value.ts@manual@O2",
  "corpus/lower/fallback/try_catch.ts@leak@O1",
  "corpus/lower/fallback/try_catch.ts@leak@O2",
  "corpus/lower/fallback/try_catch.ts@manual@O1",
  "corpus/lower/fallback/try_catch.ts@manual@O2",
  "corpus/lower/memory/grow_reuse.ts@leak@O1",
  "corpus/lower/memory/grow_reuse.ts@leak@O2",
  "corpus/lower/memory/grow_reuse.ts@manual@O1",
  "corpus/lower/memory/grow_reuse.ts@manual@O2",
  "corpus/lower/rc/adv_large_drop.ts@leak@O1",
  "corpus/lower/rc/adv_large_drop.ts@leak@O2",
  "corpus/lower/rc/adv_large_drop.ts@manual@O1",
  "corpus/lower/rc/adv_large_drop.ts@manual@O2",
  "corpus/lower/rc/adv_temporaries.ts@leak@O1",
  "corpus/lower/rc/adv_temporaries.ts@leak@O2",
  "corpus/lower/rc/adv_temporaries.ts@manual@O1",
  "corpus/lower/rc/adv_temporaries.ts@manual@O2",
  "corpus/lower/rc/cyc_large.ts@leak@O1",
  "corpus/lower/rc/cyc_large.ts@leak@O2",
  "corpus/lower/rc/cyc_large.ts@manual@O1",
  "corpus/lower/rc/cyc_large.ts@manual@O2",
]);

/** A -O1 or -O2 pin the class-id step moved, as listed. */
export const clsidMoved = (k: string): boolean => /@O[12]$/.test(k) && CLSID_MOVED.has(k);
