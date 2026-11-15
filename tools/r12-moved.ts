// Written by tools/r12-pins.ts --write: each pin R12 moved (SPEC M5's R12 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R12's changes is, by the name tools/r12-pins.ts's stages give it. */
export const R12_WHY: Record<string, string> = {};

export const R12_MOVED: Record<string, string> = {};

/** A pin R12 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r12Moved = (k: string): boolean =>
  Object.keys(R12_MOVED).some((x) => x.endsWith(`#${k}`));
