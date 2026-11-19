// R4 (SPEC 3.5, D39, D66, D72, D74): `@tsl/gc`'s freeing and rooms made cheaper, and JsMap's growth made safe to run out of
// memory in. The bugs put into each new transform, and which programs catch each, run by R2's fault runner (r2-tests.ts).
import type { R2Fault } from "./r2-tests.ts";

export const R4_FAULTS: R2Fault[] = [
  {
    name: "leaf-all",
    what: "every counted class taken as one with no slots of its own, so freeing gives back an element's block with what it holds unvisited",
    transform: "the expansion's choice of visitLeaf for a class with no slots (isLeaf)",
    where: "expansion",
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "leaf-spare-unspent",
    what: "visitLeaf giving a leaf's block back without spending the step it takes, so an allocation frees more than its budget",
    transform:
      "@tsl/gc's leaves given back at once by freeing with a step to spare (visitLeaf, D39's bound)",
    where: "library",
    patch: {
      file: "ex-gc-rc.ts",
      // R24: the same line, now in leafBack, visitLeaf's last count out of line
      from: "  spare = BigInt.asUintN(64, spare - 1n); // runSteps counts it: its steps are what the budget had, less what's left\n",
      to: "",
    },
    dirs: [],
    handWritten: "rc_steps_nocc",
  },
  {
    name: "room-keep-one-more",
    what: "a room an array of references grows into left unzeroed one word past what growth copies, so a slot a longer length reaches reads what the room held before",
    transform:
      "JsRoomArray's rooms zeroed only past what growth copies (roomMake's keep, placeTail's keep)",
    where: "library",
    patch: {
      file: "ex-gc-roomarray.ts",
      // R28: grow names what's kept `keep` (a word count with no rounding where an element is a word)
      from: "this.holes ? keep : words",
      to: "this.holes ? keep + 1 : words",
    },
    dirs: ["corpus/lower/rc-tsl"],
  },
  {
    name: "map-grow-moves-first",
    what: "JsMap's growth moving its table aside before it makes the new one (R3's order), so running out of memory partway leaves the map broken for the next case",
    transform:
      "JsMap's growth making the new table's buffers before it moves anything (grow, JsArray.swap)",
    where: "library",
    patch: {
      file: "ex-jsrt-map.ts",
      from: "    this.resize(this.okeys, want, live);\n    this.resize(this.ovals, this.withVals ? want : 0, this.withVals ? live : 0);\n    this.resize(this.ochain, want, live);\n    this.resize(this.oheads, want, want);\n    // everything allocated: from here nothing can fail\n    this.keys.swap(this.okeys);\n    this.vals.swap(this.ovals);\n    this.chain.swap(this.ochain);\n    this.heads.swap(this.oheads);\n    if (used > 0) this.startMove(used, live);\n    else this.oldGone();\n",
      to: "    if (used === 0) {\n      if (this.tables) {\n        this.keys.trim();\n        this.vals.trim();\n        this.chain.trim();\n        this.heads.trim();\n      } else {\n        this.forget(this.kd, this.keys);\n        this.forget(this.vd, this.vals);\n        this.forget(u32, this.chain);\n        this.forget(u32, this.heads);\n      }\n    } else {\n      this.okeys.adopt(this.keys);\n      this.ovals.adopt(this.vals);\n      this.ochain.adopt(this.chain);\n      this.oheads.adopt(this.heads);\n    }\n    this.resize(this.keys, want, live);\n    this.resize(this.vals, this.withVals ? want : 0, this.withVals ? live : 0);\n    this.resize(this.chain, want, live);\n    this.resize(this.heads, want, want);\n    if (used > 0) this.startMove(used, live);\n",
    },
    dirs: ["corpus/lower/memory"],
    modes: ["manual", "rc"],
    classes: true,
    only: "map_grow_oom",
  },
  {
    name: "copy-odd-short",
    what: "a small copy of 4 bytes more than a multiple of 8 made without its last 4, so an object of i32 fields placed in its slot loses its last field",
    transform:
      "the backend's small copies of an odd size made inline (an object placed in its slot by make)",
    where: "backend",
    dirs: ["corpus/lower/rc-tsl"],
    handWritten: "adv_borrow",
  },
];
