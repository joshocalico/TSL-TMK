// Which pinned tirhashes R26 moves (SPEC M5's R26 record, 4.3, 3.5, D44, D73), and why. Every pin file is computed once per
// stage, each stage turning one more of R26's changes on (TSL_TEST_PATCH puts @tsl/gc's ex-gc-rc.ts back as it was, from
// SPEC.md.bak-pre-r26's `// file:` block; TMK_R26_OFF puts the optimiser's changes and the printing back):
//
//   none     @tsl/gc as it was and every R26 change off: must give every pin as pinned, or as an earlier round listed it
//   gc       @tsl/gc as R26 has it: a fresh slot's size by a wrapping shift (pageSlot), the same size
//   range    range.ts: a signed loop test read as the unsigned one where its smaller side isn't negative, a float compare of
//            converted i32s decided from the integers as known where it is, a target reached through its own zext; and
//            -O1's loopbounds taking `k < 0` as false for a signed test's index
//   rounds   -O2's loop copying in up to three rounds, value numbering between, a loop unswitched peelable once more
//   inline   the inliner's loop blocks kept across a split, so a call after an inlined one in a loop's block is in the loop
//   codeat   class printing's charCodeAt with an i32 index in integers in rc; auto doesn't take strings in rc, so this stage
//            should move none
//
// The optimiser's changes are -O1's and -O2's (-O0 is untouched, D44), and move TSL proper's pins at those levels where they
// apply, as D44 allows an optimiser change to; the tool fails if a TSL proper pin moves at -O0 in any stage but gc, and
// lists the TSL proper pins each stage moved.
//
// `node tools/r26-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r26-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** R26's modules as they were before it (SPEC.md.bak-pre-r26's blocks), put back by TSL_TEST_PATCH: `which` says which. */
export function r26Undo(which: string[]): string {
  const blocks = new Map<string, string>();
  const spec = readFileSync(join(ROOT, "SPEC.md.bak-pre-r26"), "utf8");
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g))
    blocks.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  const dir: Record<string, string> = {
    "ex-gc-rc.ts": "packages/tsl-gc",
  };
  const out: { file: string; from: string; to: string }[] = [];
  for (const f of which) {
    const now = readFileSync(join(ROOT, dir[f]!, f), "utf8");
    const was = blocks.get(f);
    if (was === undefined) throw new Error(`SPEC.md.bak-pre-r26 has no // file: ${f}`);
    if (now !== was) out.push({ file: `${dir[f]!}/${f}`, from: now, to: was });
  }
  return JSON.stringify(out);
}

const GC = ["ex-gc-rc.ts"];

export const R26_STAGES: {
  name: string;
  undo: string[];
  off: string;
  why: string;
}[] = [
  { name: "none", undo: GC, off: "range,rounds,inline,codeat", why: "" },
  {
    name: "gc",
    undo: [],
    off: "range,rounds,inline,codeat",
    why: "@tsl/gc (R26): a fresh slot's size, 1 << k for a size class k below CLASSES, by a wrapping shift, where the checked shift tested that no bit was lost; the same size; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  },
  {
    name: "range",
    undo: [],
    off: "rounds,inline,codeat",
    why: "range.ts and loopbounds.ts (R26, D73): a signed test read as the unsigned one where its smaller side isn't negative, a float compare of two converted i32s decided from the integers as known where it is, a check's target reached through its own zext, and at -O1 `k < 0` false for a signed test's index that's never negative; checks proved and removed, and what follows them moved or folded; -O1 and -O2 only (D44)",
  },
  {
    name: "rounds",
    undo: [],
    off: "inline,codeat",
    why: "-O2's loop copying (R26, manager.ts and unswitch.ts): up to three rounds of unswitching and peeling with value numbering between, the function's growth limit shared, and a loop unswitched peelable once more, so a peeled first turn's test becomes an invariant branch to unswitch and each copy's own loads a reason to peel; -O2 only (D44)",
  },
  {
    name: "inline",
    undo: [],
    off: "codeat",
    why: "the inliner (R26, inline.ts): blocks a call in a loop's block splits off, the callee's copy and the rest of the block, kept in the loop, so a call after an inlined one there is weighed as a call in the loop (-O1's small leaf, -O2's loop factor); -O1 and -O2 only (D44)",
  },
  {
    name: "codeat",
    undo: [],
    off: "",
    why: "class printing's charCodeAt with an i32 index printed in integers in rc (R26, emit-tsl.ts); auto doesn't take strings in rc",
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

function child(st: (typeof R26_STAGES)[number]): Promise<Record<string, Got>> {
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
    if (st.undo.length > 0) env.TSL_TEST_PATCH = r26Undo(st.undo);
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
    env.TMK_R26_OFF = st.off;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r26-child"],
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
  for (const st of R26_STAGES) {
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
    for (let i = 1; i < R26_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R26_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No TSL proper pin may move at -O0 but by the library's change (D44), and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.tslProper === true &&
        (last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => x === "gc")) ||
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
  // its moves are set aside by key, with why (R26_MOVED), as R10 to R25 set theirs.
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
    const whys = R26_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r26-moved.ts"),
      `// Written by tools/r26-pins.ts --write: each pin R26 moved (SPEC M5's R26 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R26_MOVED, as R10 to R25 set theirs.

/** What each of R26's stages is, by the name tools/r26-pins.ts gives it. */
export const R26_WHY: Record<string, string> = {
${whys}
};

/** Each pin R26 moved and pinned again, with the stage that moved it. */
export const R26_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R26 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R26_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R26 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r26Moved = (k: string): boolean =>
  Object.keys(R26_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r26-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
