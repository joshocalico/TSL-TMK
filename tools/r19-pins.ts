// Which pinned tirhashes R19 moves (SPEC M5's R19 record, 3.4, 3.5, D39, D44, D73), and why. Every pin file is computed once
// per stage, each stage turning one more of R19's changes on (TSL_TEST_PATCH puts @tsl/gc's ex-gc-rc.ts back as it was, from
// SPEC.md.bak-pre-r19's `// file:` block):
//
//   none        @tsl/gc as it was, R19's printing off (TMK_R19_OFF=inline) and tslc's rule off (TMK_TSL_OPT_OFF=ctorfields):
//               must give every pin as pinned, or as an earlier step listed it
//   gc          @tsl/gc as R19 has it: a tail of any length made in line (`tailFast`, sizeClass inlined), roomMake and
//               roomAddr inlined, a fresh slot cut from a page of its size class without the collector (`pageSlot`,
//               `freshSlot`, slotFor's fast path inlined), and an object freed with the cursor idle by `freeFlat`
//   inline      class printing in `rc`: an environment's `call`, and each of its kinds' methods that's small, `@tsl.inline`
//   ctorfields  tslc (markInvariantFields): a lowered `rc` package's counted class's fields stored by its constructor alone
//               noted invariant (`load.T.inv`, at -O1 and -O2 only, so no -O0 pin)
//
// The backend's change (a `!` left to the load through a reference's address) is machine code, not TIR, and moves nothing
// pinned. A library change may move a lowered program's pins at every level, and a hand-written TSL program's that uses it
// (D44); the tool fails if a TSL proper pin moves at -O0 in any other stage, and lists those the library moved.
//
// `node tools/r19-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r19-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** R19's modules as they were before it (SPEC.md.bak-pre-r19's blocks), put back by TSL_TEST_PATCH: `which` says which. */
export function r19Undo(which: string[]): string {
  const blocks = new Map<string, string>();
  const spec = readFileSync(join(ROOT, "SPEC.md.bak-pre-r19"), "utf8");
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g))
    blocks.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  const dir: Record<string, string> = {
    "ex-gc-rc.ts": "packages/tsl-gc",
  };
  const out: { file: string; from: string; to: string }[] = [];
  for (const f of which) {
    const now = readFileSync(join(ROOT, dir[f]!, f), "utf8");
    const was = blocks.get(f);
    if (was === undefined) throw new Error(`SPEC.md.bak-pre-r19 has no // file: ${f}`);
    if (now !== was) out.push({ file: `${dir[f]!}/${f}`, from: now, to: was });
  }
  return JSON.stringify(out);
}

const GC = ["ex-gc-rc.ts"];

export const R19_STAGES: {
  name: string;
  undo: string[];
  off: string;
  optOff: string;
  why: string;
}[] = [
  { name: "none", undo: GC, off: "inline", optOff: "ctorfields", why: "" },
  {
    name: "gc",
    undo: [],
    off: "inline",
    optOff: "ctorfields",
    why: "@tsl/gc (R19, D39): a tail of any length made in line (tailFast, sizeClass inlined), roomMake and roomAddr inlined, a fresh slot cut from a page of its size class without the collector (pageSlot, freshSlot, slotFor's fast path inlined), and an object freed with the cursor idle by freeFlat, the same steps; a library change, which moves the pins of an rc program, lowered or hand-written, that uses it at every level (D44)",
  },
  {
    name: "inline",
    undo: [],
    off: "",
    optOff: "ctorfields",
    why: "class printing in rc (R19, emit-tsl.ts): an environment's call, and each of its kinds' methods of six lines or fewer with no loop, printed @tsl.inline, so a closure called in a loop is its compare chain and its kind's code there",
  },
  {
    name: "ctorfields",
    undo: [],
    off: "",
    optOff: "",
    why: "tslc (R19, markInvariantFields, D73): a lowered rc package's counted class's fields stored by its constructor alone (an environment's kind and captures) noted invariant, load.T.inv at -O1 and -O2",
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

function child(st: (typeof R19_STAGES)[number]): Promise<Record<string, Got>> {
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
    if (st.undo.length > 0) env.TSL_TEST_PATCH = r19Undo(st.undo);
    delete env.TMK_R16_OFF;
    delete env.TMK_R17_OFF;
    delete env.TMK_R18_OFF;
    env.TMK_R19_OFF = st.off;
    env.TMK_TSL_OPT_OFF = st.optOff;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r19-child"],
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
  for (const st of R19_STAGES) {
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
    for (let i = 1; i < R19_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R19_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No TSL proper pin may move at -O0 but by the library's change (D44), and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.tslProper === true && (last[k]?.level ?? 0) === 0 && stageOf[k] !== "gc") ||
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
  // its moves are set aside by key, with why (R19_MOVED), as R10 to R12 set theirs.
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
    const whys = R19_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r19-moved.ts"),
      `// Written by tools/r19-pins.ts --write: each pin R19 moved (SPEC M5's R19 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R19_MOVED, as R10 to R18 set theirs.

/** What each of R19's stages is, by the name tools/r19-pins.ts gives it. */
export const R19_WHY: Record<string, string> = {
${whys}
};

/** Each pin R19 moved and pinned again, with the stage that moved it. */
export const R19_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R19 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R19_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R19 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r19Moved = (k: string): boolean =>
  Object.keys(R19_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r19-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
