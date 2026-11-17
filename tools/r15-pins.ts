// Which pinned tirhashes R15 moves (SPEC M5's R15 record, D44, D73, pile item 10), and why. Every pin file is computed once
// per stage, each stage turning one more of R15's passes on (TMK_OPT_DISABLE turns the rest off):
//
//   none      R15's passes off: must give every pin as pinned, or as an earlier step listed it
//   conds     conds.ts at -O1 and -O2: a test a test above it answered goes (a branch on a value a dominating branch
//             decided, a compare the relations known decide, a bounds check under a test that proves it)
//   version   version.ts at -O2: a loop whose checks a guard before it proves gets a fast copy without them, the loop as it
//             was the fallback
//
// Neither runs at -O0, so no -O0 pin may move (D44), and the tool fails if one does. A TSL proper pin may move at -O1 and
// -O2 (the passes are the optimiser's, for every program), each listed with what moved it: the stage, and the pass's own
// counts for that build (branches, compares and bounds checks conds.ts removed; loops version.ts versioned and the checks
// gone from their fast copies), read from the optimiser's report.
//
// R15's other changes move nothing by construction, and the `none` stage shows it: the injected bugs (TMK_OPT_FAULT only),
// tslc's TMK_TRUST_IN (measurement only), the tools and the test program (a new program, pinned new).
//
// `node tools/r15-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (each is an -O1 or -O2 build, so every pin stays compared exactly, none set aside as earlier
// rounds' lists set theirs), and writes tools/r15-moved.ts, the record of each move with what moved it.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

export const R15_STAGES: { name: string; disable: string; why: string }[] = [
  { name: "none", disable: "conds,version", why: "" },
  {
    name: "conds",
    disable: "version",
    why: "conds.ts (R15, -O1 and -O2): a test a test above it answered goes, a branch on a value a dominating branch decided, a compare the relations known decide, a bounds check under a test that proves it",
  },
  {
    name: "version",
    disable: "",
    why: "version.ts (R15, -O2): a loop whose checks a guard before it proves gets a fast copy without them, and keeps the loop as it was for when the guard fails",
  },
];

interface Got {
  h: string;
  level?: number;
  mode?: string;
  tslProper?: boolean;
  /** conds.ts's and version.ts's counts for this build */
  n?: { branches: number; compares: number; bounds: number; loops: number; checks: number };
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
      const counts = (
        r:
          | {
              conds: { branches: number; compares: number; bounds: number };
              version: { loops: number; checks: number };
            }
          | undefined,
      ) =>
        r === undefined
          ? undefined
          : {
              branches: r.conds.branches,
              compares: r.conds.compares,
              bounds: r.conds.bounds,
              loops: r.version.loops,
              checks: r.version.checks,
            };
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
          const n = counts(o.opt);
          out[id] = {
            h: o.tirHash,
            level,
            mode,
            tslProper: true,
            ...(n !== undefined ? { n } : {}),
          };
        } else {
          const r = lowerFile(b.path, b.opts as never);
          const n = counts(r.opt);
          out[id] = {
            h: r.tirHash,
            level,
            mode,
            tslProper: false,
            ...(n !== undefined ? { n } : {}),
          };
        }
      } catch (e) {
        out[id] = { h: `threw:${String(e).slice(0, 80)}`, level, mode };
      }
    }
  }
  return out;
}

function child(st: (typeof R15_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_OPT_DISABLE: st.disable,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TMK_OPT_FAULT;
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    delete env.TMK_EMIT_STRICT;
    delete env.TMK_EMIT_STRICT_ARRAYS;
    delete env.TMK_TRUST_RESHAPES;
    delete env.TMK_TRUST_IN;
    delete env.TMK_TEST_EMIT;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r15-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

/** A moved pin's line in tools/r15-moved.ts: its stage, and the counts that say what moved it. */
function explain(stage: string, g: Got | undefined): string {
  const n = g?.n;
  if (n === undefined) return stage;
  const parts: string[] = [];
  if (stage.includes("conds"))
    parts.push(`conds: ${n.branches} branches, ${n.compares} compares, ${n.bounds} bounds checks`);
  if (stage.includes("version")) parts.push(`version: ${n.loops} loops, ${n.checks} checks`);
  return `${stage} (${parts.join("; ")})`;
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  // One at a time: one compile each (one heavy job, as the round's rules ask).
  const stages: Record<string, Got>[] = [];
  for (const st of R15_STAGES) stages.push(await child(st));
  console.error(`stages: ${Math.round((Date.now() - t0) / 1000)} s`);
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
    for (let i = 1; i < R15_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R15_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No -O0 build may move (D44: neither pass runs there), and `version` only at -O2.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.level ?? 0) === 0 ||
      (stageOf[k]!.includes("version") && (last[k]?.level ?? 0) !== 2),
  );
  const programs = [...new Set(Object.keys(stageOf).map((k) => k.split("#")[1]!.split("@")[0]!))];
  const proper = Object.keys(stageOf).filter((k) => last[k]?.tslProper === true);
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        tslProperMoved: proper.length,
        unexplained,
        bad,
        programs: programs.sort(),
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(stageOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
        byStage: Object.fromEntries(
          [...new Set(Object.values(stageOf))].map((s) => [
            s,
            Object.values(stageOf).filter((x) => x === s).length,
          ]),
        ),
        movedKeys: Object.fromEntries(
          Object.entries(stageOf).map(([k, s]) => [k, explain(s, last[k])]),
        ),
      },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write") && unexplained.length === 0 && bad.length === 0) {
    for (const file of FILES) {
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
    for (const [id, s] of Object.entries(stageOf).sort()) {
      rows.push(`  ${JSON.stringify(id)}: ${JSON.stringify(explain(s, last[id]))},`);
    }
    const whys = R15_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r15-moved.ts"),
      `// Written by tools/r15-pins.ts --write: each pin R15 moved (SPEC M5's R15 record), by pin file and key, with the pass that
// moved it and that pass's counts for the build. Each is pinned again in its file, so every pin is still compared exactly:
// none is set aside (r15Moved is false for all), and this is the record of why each moved.

/** What each of R15's passes is, by the name tools/r15-pins.ts's stages give it. */
export const R15_WHY: Record<string, string> = {
${whys}
};

/** Each pin R15 moved and pinned again, with the pass that moved it and that pass's counts for the build. */
export const R15_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R15 moved and set aside: none (each is pinned again, above). */
export const R15_MOVED: Record<string, string> = {};

/** A pin R15 moved, by its key (\`file@mode@O1\` and the like), in any pin file: none is set aside. */
export const r15Moved = (k: string): boolean =>
  Object.keys(R15_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r15-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r15-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
