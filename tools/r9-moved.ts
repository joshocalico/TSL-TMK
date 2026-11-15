// Written by tools/r9-pins.ts --write: each pin R9 moved (SPEC M5's R9 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R9's changes is, by the name tools/r9-pins.ts's stages give it. */
export const R9_WHY: Record<string, string> = {};

export const R9_MOVED: Record<string, string> = {};

/** A pin R9 moved, by its key (`file@mode@O1` and the like), in any pin file. */
export const r9Moved = (k: string): boolean =>
  Object.keys(R9_MOVED).some((x) => x.endsWith(`#${k}`));
