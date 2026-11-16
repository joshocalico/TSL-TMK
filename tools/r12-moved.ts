// Written from tools/r12-pins.ts's run: each pin R12 moved (SPEC M5's R12 record), by pin file and key, with the change that
// moved it. (R12's run moved 9 of 3,862, all `strict` builds of corpus/lower/pos/class_struct.ts and
// corpus/lower/rc/adv_control_paths.ts, the two pinned programs with a class that class printing in `strict` takes exactly;
// none in maps-tirhash.json or pipe-tirhash.json, and none of TSL proper's.)

/** What each of R12's changes is, by the name tools/r12-pins.ts's stages give it. */
export const R12_WHY: Record<string, string> = {
  strict:
    "in strict, auto prints a program's objects as TSL classes where the printing takes it exactly and it has a class, what escapes its function in the call arena (R12)",
};

export const R12_MOVED: Record<string, string> = {
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@strict@O1": "strict",
  "corpus/memory/opt-tirhash.json#corpus/lower/pos/class_struct.ts@strict@O2": "strict",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict@O1": "strict",
  "corpus/memory/opt-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict@O2": "strict",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/pos/class_struct.ts@strict": "strict",
  "corpus/memory/pre-std-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict": "strict",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/pos/class_struct.ts@strict": "strict",
  "corpus/memory/pre-strings-tirhash.json#corpus/lower/rc/adv_control_paths.ts@strict": "strict",
  "corpus/memory/strict-tirhash.json#corpus/lower/pos/class_struct.ts": "strict",
};

/** A pin R12 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r12Moved = (k: string): boolean =>
  Object.keys(R12_MOVED).some((x) => x.endsWith(`#${k}`));
