// R3 (SPEC 3.5, 4.5, D39, D41, D69, D74): closures as values through the TSL route, arrays' buffers in the counted heap, the
// direct route's store-order fix and `@tsl/jsrt`'s bookkeeping freed in `rc`. The bugs put into each new transform, and which
// programs catch each, run by R2's fault runner (r2-tests.ts).
import type { R2Fault } from "./r2-tests.ts";

export const R3_FAULTS: R2Fault[] = [
  {
    name: "room-past-tail",
    what: "a lowered rc array's first room taken as one element longer than its holder's tail, so a push writes past it",
    transform: "the printer's rc array holders, whose first room is their own tail (D69)",
    where: "printer",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "rooms-uncounted",
    what: "freeing an rc array's holder with no step for its room, so a room it outgrew its tail into is never given back",
    transform:
      "the expansion's freeing of a JsRoomArray holder (its room counted only where it has one)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "grow-keeps",
    what: "JsRoomArray's growth not letting go of the room it outgrew",
    transform: "JsRoomArray's rooms in the counted heap (grow)",
    where: "library",
    patch: {
      file: "ex-gc-roomarray.ts",
      from: "    if (old !== null) roomDrop(old);",
      to: "",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "env-wrong-kind",
    what: "an environment class's call testing each kind against the next kind's number, so a closure value runs another closure",
    transform:
      "the printer's closure values (an environment class with a kind field, its call picking the kind's method)",
    where: "printer",
    dirs: ["corpus/lower/fallback", "corpus/lower/rc", "corpus/lower/pipe", "corpus/lower/rc-tsl"],
  },
  {
    name: "env-share-own",
    what: "two captures of one closure put in one field of its environment class, so one overwrites the other",
    transform: "the printer's environment fields, shared between kinds by type (planEnv)",
    where: "printer",
    dirs: ["corpus/lower/fallback", "corpus/lower/rc", "corpus/lower/pipe", "corpus/lower/rc-tsl"],
  },
  {
    name: "splice-room",
    what: "a splice's new room written before JsArray's length covers it, as the lowering writes it, so set traps past the length",
    transform: "the printer's splice (a reserve whose room is written first raises the length)",
    where: "printer",
    dirs: ["corpus/lower/rc"],
  },
  {
    name: "cursor-unclosed",
    what: "a map's cursor never closed where its variable's scope ends, so the map's generations and cursors aren't reused",
    transform: "the expansion's closing of a JsMap or JsSet cursor at every way out of its scope",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "cursors-not-reused",
    what: "JsMap's close not keeping the cursor for reuse, so each iteration makes one that's never freed",
    transform: "JsMap's cursors reused once closed (cursor and close)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "    c.link = freeCursors;\n    freeCursors = c;\n",
      to: "",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "gens-not-reused",
    what: "JsMap's generations let go of once no cursor is open, not kept for reuse, so each move or clear an iteration sees makes one",
    transform: "JsMap's generations reused once no cursor is open (retire)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "      g.next = freeGens;\n      freeGens = g;\n",
      to: "      g.next = null;\n",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "ranks-left-live",
    what: "a generation left reading the old chain after its table is gone, where the move put each position not taken over",
    transform:
      "JsMap's ranks kept by the generation that reads them when the old table goes (keepRanks)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      // R29: keepRanks is the start of oldGone now
      from: "    if (g !== null && g.live) {",
      to: "    if (g !== null && !g.live) {",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "old-table-kept",
    what: "a map freed mid-move keeping its old table's buffers, now the map's own arrays held in place",
    transform: "JsMap's trim, both tables' arrays given back",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "    if (this.okeys.trim()) any = true;\n    if (this.ovals.trim()) any = true;\n    if (this.ochain.trim()) any = true;\n    if (this.oheads.trim()) any = true;\n",
      to: "",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "narrow-reassigned",
    what: "tsc's narrowing of `p.f` after `p.f = ((p = q), v)` trusted, so q's f is taken to be set (native 7008, V8 7007)",
    transform:
      "the lowering's distrust of a place narrowed by an assignment whose right side reassigns what the place is read through",
    where: "lowering",
    // corpus/lower/pos/store_target_order.ts catches it too, but pos has traps V8 doesn't share (3.10), which this run
    // would count as caught
    dirs: ["corpus/lower/pipe"],
    modes: ["strict", "rc"],
  },
];
