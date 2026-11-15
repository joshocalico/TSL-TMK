// Which pinned tirhashes R8 moves (SPEC M5's R8 record, D36, D39, D74), and why. Every pin file is computed once per stage,
// each stage turning one more of R8's changes on (TSL_TEST_PATCH puts @tsl/gc's two changed methods back as they were;
// TMK_R8_OFF turns off the lowering's and the printer's):
//
//   none      all of R8 off: must give every pin as pinned, or as an earlier step listed it moved (maps-pins.ts's mapsMoved)
//   gclib     @tsl/gc's `weakGen` and `count` read a counted-exactly object's generation from its slot (packages/tsl-gc)
//   untag     a reference to an object tslc's `rc` expansion counts is a plain address, with no generation in its top bits
//             (lower-native.ts's placeObject, placeTail and objectAt; expand-rc.ts's untaggedCounted)
//   boundary  `rc` objects crossing an export printed with the native caller's place, retain and release (emit-tsl.ts), which
//             `auto` doesn't print (AUTO_BOUNDARY): it must move nothing
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else. For gclib and
// untag, each such build is an `rc` build through the TSL route (its classes counted by the expansion); boundary moves none.
//
// `node tools/r8-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r8-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

/** @tsl/gc's two methods R8 changed, put back as they were (TSL_TEST_PATCH, a list). */
export const R8_GC_UNDO = [
  {
    file: "ex-gc-rc.ts",
    from: `    const slot = this.slotIn(h);
    if (countedExactly<T>()) return genAt(slot).read() % 0x1_0000;
    return genOf(h);`,
    to: `    this.slotIn(h);
    return genOf(h);`,
  },
  {
    file: "ex-gc-rc.ts",
    from: `    // a reference tslc's expansion counts is a plain address, with no generation to check (R8)
    if (countedExactly<T>()) return toU32(countAt(slotOfLive(h)).read() & COUNT);
`,
    to: "",
  },
];

export const R8_STAGES: { name: string; off: string; undoGc: boolean; why: string }[] = [
  { name: "none", off: "untag,boundary", undoGc: true, why: "" },
  {
    name: "gclib",
    off: "untag,boundary",
    undoGc: false,
    why: "@tsl/gc's weakGen and count read the generation of an object tslc's rc expansion counts from its slot, where its reference no longer carries one (R8)",
  },
  {
    name: "untag",
    off: "boundary",
    undoGc: false,
    why: "a reference to an object tslc's rc expansion counts is a plain address, with no generation in its top bits (R8): placeObject, placeTail and objectAt make no tag for such a class, so a native caller holds, reads and writes it at its address",
  },
  {
    name: "boundary",
    off: "",
    undoGc: false,
    why: "rc objects crossing an export printed with a native caller's place, retain and release (R8), which auto doesn't print",
  },
];

interface Got {
  h: string;
  classed?: boolean; // printed with classes through the TSL route
  level?: number;
  mode?: string;
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
            out[id] = { h: `diags:${c.diags.map((x) => x.code).join()}`, level, mode };
            continue;
          }
          out[id] = { h: compileTyped(c.typed, { opt: level as 0 | 1 | 2 }).tirHash, level, mode };
        } else {
          const r = lowerFile(b.path, b.opts as never);
          out[id] = {
            h: r.tirHash,
            classed:
              r.tsl !== undefined &&
              r.tslSkipped === undefined &&
              /(^|\n)(export )?class /.test(r.tsl.text),
            level,
            mode,
          };
        }
      } catch (e) {
        out[id] = { h: `threw:${String(e).slice(0, 80)}`, level, mode };
      }
    }
  }
  return out;
}

function child(st: (typeof R8_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_R8_OFF: st.off,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    if (st.undoGc) env.TSL_TEST_PATCH = JSON.stringify(R8_GC_UNDO);
    else delete env.TSL_TEST_PATCH;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r8-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  const stages: Record<string, Got>[] = Array.from({ length: R8_STAGES.length }, () => ({}));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < R8_STAGES.length) {
      const i = next++;
      stages[i] = await child(R8_STAGES[i]!);
      console.error(`stage ${R8_STAGES[i]!.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };
  // Two at a time: one compile each, so about two cores (one heavy job, as the round's rules ask).
  await Promise.all([worker(), worker()]);
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
  const bad: string[] = [];
  for (const k of Object.keys(pinned)) {
    const moved: string[] = [];
    for (let i = 1; i < R8_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R8_STAGES[i]!.name);
    if (moved.length === 0) continue;
    stageOf[k] = moved.join("+");
    for (const s of moved) {
      const g = stages[R8_STAGES.findIndex((x) => x.name === s)]![k];
      if (s === "boundary") bad.push(`${k}: moved by boundary, which auto doesn't print`);
      else if (!(g?.mode === "rc" && g.classed === true))
        bad.push(
          `${k}: moved by ${s}, but not an rc build through the TSL route (${g?.mode}, classed ${g?.classed})`,
        );
    }
  }
  const last = stages[stages.length - 1]!;
  const byStage: Record<string, number> = {};
  for (const s of Object.values(stageOf)) byStage[s] = (byStage[s] ?? 0) + 1;
  const programs: Record<string, Set<string>> = {};
  for (const [k, s] of Object.entries(stageOf))
    (programs[s] ??= new Set()).add(k.split("#")[1]!.split("@")[0]!);
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        unexplained,
        bad,
        byStage,
        programsByStage: Object.fromEntries(
          Object.entries(programs).map(([s, f]) => [s, [...f].sort()]),
        ),
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(stageOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
        movedTslProper: Object.keys(stageOf).filter(
          (k) => buildOf(k.split("#")[0]!, k.split("#")[1]!).tslProper,
        ),
      },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write") && unexplained.length === 0 && bad.length === 0) {
    for (const file of EXACT) {
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const pin = JSON.parse(text) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const id = `${file}#${k}`;
        if (stageOf[id] !== undefined) pin[k] = last[id]!.h;
      }
      const indent = /\n( +)"/.exec(text)?.[1] ?? " ";
      writeFileSync(path, `${JSON.stringify(pin, null, indent.length)}\n`);
    }
    const rows: string[] = [];
    for (const [id, s] of Object.entries(stageOf).sort()) {
      if (EXACT.includes(id.split("#")[0]!)) continue;
      rows.push(`  ${JSON.stringify(id)}: ${JSON.stringify(s)},`);
    }
    const whys = R8_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r8-moved.ts"),
      `// Written by tools/r8-pins.ts --write: each pin R8 moved (SPEC M5's R8 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R8's changes is, by the name tools/r8-pins.ts's stages give it. */
export const R8_WHY: Record<string, string> = {
${whys}
};

export const R8_MOVED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R8 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r8Moved = (k: string): boolean =>
  Object.keys(R8_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r8-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r8-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
