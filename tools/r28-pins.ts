// Which pinned tirhashes R28 moves (SPEC M5's R28 record, 3.5, 4.3, D44, D73, D78), and why. Every pin file is computed once per
// stage, each stage turning one more of R28's changes on (TSL_TEST_PATCH puts @tsl/gc's ex-gc-rc.ts and ex-gc-roomarray.ts
// back as they were, from SPEC.md.bak-pre-r28's `// file:` blocks; TMK_R28_OFF puts tslc's and the optimiser's changes back):
//
//   none      @tsl/gc as it was and every R28 change off: must give every pin as pinned, or as an earlier round listed it
//   gc        @tsl/gc as R28 has it: a fresh slot cut in line in make's and tailFast's fast paths (pageCut), freeAlloc's
//             release call given objectAt itself, JsRoomArray's attach inlined and its growth counting words with no
//             rounding where an element is a word; a library change, which moves an rc program's pins at every level
//   zero      placeTail's zeroing a word at a time in line, up to 128 bytes (lower-native.ts): every level
//   untag     a lowered rc package's heap class's references with no tag (lower-native.ts, elab-native.ts): every level
//   initonly  a module variable only __init writes given to a call borrowed (expand-rc.ts): every level
//   tag       ref.addr of a tag or'd into the top 16 bits taken as the address's (simplify.ts): -O1 and -O2
//   consts    dominating conditions taking two equal constants as one operand (conds.ts): -O1 and -O2
//   grow      the inliner taking a callee no bigger than its call past the caller's growth limit (inline.ts): -O1, -O2
//   version   -O2's second versioning pass, over the loops the first left (manager.ts, version.ts): -O2
//   strings   auto taking a lowered rc program with strings through the TSL route (tslc.ts's AUTO_RC_STRINGS): every level
//
// The tool fails if a pin moves at -O0 in an optimiser stage (tag, consts, grow, version), and lists the TSL proper pins
// each stage moved.
//
// `node tools/r28-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r28-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** R28's modules as they were before it (SPEC.md.bak-pre-r28's blocks), put back by TSL_TEST_PATCH: `which` says which. */
export function r28Undo(which: string[]): string {
  const blocks = new Map<string, string>();
  const spec = readFileSync(join(ROOT, "SPEC.md.bak-pre-r28"), "utf8");
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g))
    blocks.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  const dir: Record<string, string> = {
    "ex-gc-rc.ts": "packages/tsl-gc",
    "ex-gc-roomarray.ts": "packages/tsl-gc",
  };
  const out: { file: string; from: string; to: string }[] = [];
  for (const f of which) {
    const now = readFileSync(join(ROOT, dir[f]!, f), "utf8");
    const was = blocks.get(f);
    if (was === undefined) throw new Error(`SPEC.md.bak-pre-r28 has no // file: ${f}`);
    if (now !== was) out.push({ file: `${dir[f]!}/${f}`, from: now, to: was });
  }
  return JSON.stringify(out);
}

const GC = ["ex-gc-rc.ts", "ex-gc-roomarray.ts"];

/** The stages that are library, lowering or expansion changes, not the optimiser's: they may move -O0 pins (D44). */
const EVERY_LEVEL = ["gc", "zero", "untag", "initonly", "strings"];

export const R28_STAGES: {
  name: string;
  undo: string[];
  off: string;
  why: string;
}[] = [
  {
    name: "none",
    undo: GC,
    off: "zero,untag,initonly,tag,consts,grow,version,strings",
    why: "",
  },
  {
    name: "gc",
    undo: [],
    off: "zero,untag,initonly,tag,consts,grow,version,strings",
    why: "@tsl/gc (R28): a fresh slot cut in line in make's and tailFast's fast paths where its page has room (pageCut), freeAlloc's release call given objectAt itself, JsRoomArray's attach inlined and its growth counting words with no rounding where an element is a word; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level",
  },
  {
    name: "zero",
    undo: [],
    off: "untag,initonly,tag,consts,grow,version,strings",
    why: "placeTail's zeroing a word at a time in line up to 128 bytes (R28, lower-native.ts), the fields before the length copied after; every level",
  },
  {
    name: "untag",
    undo: [],
    off: "initonly,tag,consts,grow,version,strings",
    why: "a lowered rc package's heap class's references with no tag (R28, D78): fields read and written and slots found with no mask, and freeing's release call handing such a class its object as an address (lower-native.ts, elab-native.ts); every level",
  },
  {
    name: "initonly",
    undo: [],
    off: "tag,consts,grow,version,strings",
    why: "a module variable only __init writes (a printed string literal's) given to a call borrowed, with no count of its own around the call (R28, expand-rc.ts); every level",
  },
  {
    name: "tag",
    undo: [],
    off: "consts,grow,version,strings",
    why: "ref.addr of a value with a tag or'd into its top 16 bits taken as the address's (R28, simplify.ts), the tag's work left for DCE; -O1 and -O2 only (D44)",
  },
  {
    name: "consts",
    undo: [],
    off: "grow,version,strings",
    why: "dominating conditions taking two integer constants of one type and value as one operand (R28, conds.ts); -O1 and -O2 only (D44)",
  },
  {
    name: "grow",
    undo: [],
    off: "version,strings",
    why: "the inliner taking a callee no bigger than its call past the caller's growth limit (R28, inline.ts); -O1 and -O2 only (D44)",
  },
  {
    name: "version",
    undo: [],
    off: "strings",
    why: "-O2's second loop versioning pass, after the copying rounds, over the loops the first pass didn't version (R28, manager.ts, version.ts); -O2 only (D44)",
  },
  {
    name: "strings",
    undo: [],
    off: "",
    why: "auto takes a lowered rc program with strings through the TSL route (AUTO_RC_STRINGS on, R28): every rc strings benchmark at or under 1.00 at -O1 and -O2; every level",
  },
];

interface Got {
  h: string;
  level?: number;
  mode?: string;
  tslProper?: boolean;
}

async function computeAll(): Promise<Record<string, Got>> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const out: Record<string, Got> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const id = `${file}#${key}`;
      const b = buildOf(file, key);
      const level = b.opts.opt as number;
      const mode = (b.opts.memory as string | undefined) ?? "strict";
      try {
        if (b.tslProper) {
          const c = checkFile(b.path);
          if (c.typed === null) {
            out[id] = {
              h: `diags:${c.diags.map((x) => x.code).join()}`,
              level,
              mode,
              tslProper: true,
            };
            continue;
          }
          const o = compileTyped(c.typed, { opt: level as 0 | 1 | 2 });
          out[id] = { h: o.tirHash, level, mode, tslProper: true };
        } else {
          const r = lowerFile(b.path, b.opts as never);
          out[id] = { h: r.tirHash, level, mode, tslProper: false };
        }
      } catch (e) {
        out[id] = { h: `threw:${String(e).slice(0, 80)}`, level, mode };
      }
    }
  }
  return out;
}

function child(st: (typeof R28_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TMK_OPT_FAULT;
    delete env.TMK_OPT_DISABLE;
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    delete env.TMK_EMIT_STRICT;
    delete env.TMK_EMIT_STRICT_ARRAYS;
    delete env.TMK_TRUST_RESHAPES;
    delete env.TMK_TRUST_IN;
    delete env.TMK_TEST_EMIT;
    delete env.TMK_TEST_TSL;
    if (st.undo.length > 0) env.TSL_TEST_PATCH = r28Undo(st.undo);
    delete env.TMK_R16_OFF;
    delete env.TMK_R17_OFF;
    delete env.TMK_R18_OFF;
    delete env.TMK_R19_OFF;
    delete env.TMK_R20_OFF;
    delete env.TMK_TSL_OPT_OFF;
    delete env.TMK_R21_OFF;
    delete env.TMK_R22_OFF;
    delete env.TMK_R23_OFF;
    delete env.TMK_R24_OFF;
    delete env.TMK_R25_OFF;
    delete env.TMK_R26_OFF;
    delete env.TMK_R27_OFF;
    delete env.TMK_R8_OFF;
    env.TMK_R28_OFF = st.off;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r28-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  // One at a time: one compile each (one heavy job, as the round's rules ask).
  const stages: Record<string, Got>[] = [];
  for (const st of R28_STAGES) {
    stages.push(await child(st));
    console.error(`stage ${st.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  const pinned: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin)) pinned[`${file}#${k}`] = v;
  }
  const base = stages[0]!;
  const unexplained = Object.keys(pinned).filter(
    (k) => base[k]?.h !== pinned[k] && !mapsMoved(k.split("#")[1]!),
  );
  const stageOf: Record<string, string> = {};
  for (const k of Object.keys(pinned)) {
    const moved: string[] = [];
    for (let i = 1; i < R28_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R28_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No TSL proper pin may move at -O0 but by the library's change (D44), and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.tslProper === true &&
        (last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => EVERY_LEVEL.includes(x))) ||
      ((last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => EVERY_LEVEL.includes(x))) ||
      /^(threw|diags):/.test(last[k]?.h ?? ""),
  );
  const libraryProper = Object.keys(stageOf).filter(
    (k) => last[k]?.tslProper === true && (last[k]?.level ?? 0) === 0,
  );
  const programs = [...new Set(Object.keys(stageOf).map((k) => k.split("#")[1]!.split("@")[0]!))];
  const proper = Object.keys(stageOf).filter((k) => last[k]?.tslProper === true);
  const byLevel: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  for (const k of Object.keys(stageOf)) {
    byLevel[`O${last[k]?.level ?? "?"}`] = (byLevel[`O${last[k]?.level ?? "?"}`] ?? 0) + 1;
    byMode[last[k]?.mode ?? "?"] = (byMode[last[k]?.mode ?? "?"] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        tslProperMoved: proper.length,
        tslProperKeys: Object.fromEntries(proper.map((k) => [k, stageOf[k]!])),
        tslProperO0ByLibrary: libraryProper,
        unexplained,
        bad,
        byLevel,
        byMode,
        programs: programs.sort(),
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(stageOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
        movedKeys: stageOf,
      },
      null,
      1,
    ),
  );
  // A pin file left read-only (corpus/memory/pre-strings-tirhash.json, the state before strings) is never pinned again:
  // its moves are set aside by key, with why (R28_MOVED), as R10 to R25 set theirs.
  const frozen = (file: string): boolean => {
    try {
      accessSync(join(ROOT, file), constants.W_OK);
      return false;
    } catch {
      return true;
    }
  };
  if (process.argv.includes("--write") && unexplained.length === 0 && bad.length === 0) {
    for (const file of FILES) {
      if (frozen(file)) continue;
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const pin = JSON.parse(text) as Record<string, string>;
      let changed = false;
      for (const k of Object.keys(pin)) {
        const id = `${file}#${k}`;
        if (stageOf[id] !== undefined) {
          pin[k] = last[id]!.h;
          changed = true;
        }
      }
      const indent = /\n( +)"/.exec(text)?.[1] ?? " ";
      if (changed) writeFileSync(path, `${JSON.stringify(pin, null, indent.length)}\n`);
    }
    const rows: string[] = [];
    const aside: string[] = [];
    for (const [id, s] of Object.entries(stageOf).sort())
      (frozen(id.split("#")[0]!) ? aside : rows).push(
        `  ${JSON.stringify(id)}: ${JSON.stringify(s)},`,
      );
    const whys = R28_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r28-moved.ts"),
      `// Written by tools/r28-pins.ts --write: each pin R28 moved (SPEC M5's R28 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R28_MOVED, as R10 to R25 set theirs.

/** What each of R28's stages is, by the name tools/r28-pins.ts gives it. */
export const R28_WHY: Record<string, string> = {
${whys}
};

/** Each pin R28 moved and pinned again, with the stage that moved it. */
export const R28_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R28 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R28_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R28 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r28Moved = (k: string): boolean =>
  Object.keys(R28_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r28-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
