// Which pinned tirhashes R10 moves (SPEC M5's R10 record, 3.5, 4.5, D42, D74), and why. Every pin file is computed once
// per stage, each stage turning one more of R10's changes on (TMK_R10_OFF, a list, turns them off):
//
//   none      all of R10 off: must give every pin as pinned, or as an earlier step listed it moved (mapsMoved)
//   dead      in `rc`, a statement list printed up to its first that never goes on (emit-tsl.ts's liveStmts)
//   mapargs   in `rc`, a map made as a call's argument a statement of its own first (emit-tsl.ts)
//   typed     in `rc`, a constant length's typed array made in a function printed as a layout class's array, which the
//             expansion doesn't count (expand-rc.ts's isLayoutStorage), on the stack
//   strings   strings in `rc` printed as the program's own JsStr (emit-rcstr.ts), and with them exceptions and the map
//             runtime refused by name in `rc`, which `auto` doesn't print (AUTO_RC_STRINGS): it must move nothing
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else.
//
// `node tools/r10-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r10-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

const ALL = "dead,mapargs,typed,strings";

export const R10_STAGES: { name: string; off: string; why: string }[] = [
  { name: "none", off: ALL, why: "" },
  {
    name: "dead",
    off: "mapargs,typed,strings",
    why: "in rc, a statement list printed up to its first statement that never goes on, what follows being dead (R10)",
  },
  {
    name: "mapargs",
    off: "typed,strings",
    why: "in rc, a map made as a call's argument printed as a statement of its own first (R10)",
  },
  {
    name: "typed",
    off: "strings",
    why: "in rc, a constant length's typed array made in a function printed as an uncounted layout class's array, on the stack (R10)",
  },
  {
    name: "strings",
    off: "",
    why: "strings in rc printed as the program's own JsStr, exceptions and the map runtime refused by name in rc (R10), which auto doesn't print",
  },
];

interface Got {
  h: string;
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
          out[id] = { h: r.tirHash, level, mode };
        }
      } catch (e) {
        out[id] = { h: `threw:${String(e).slice(0, 80)}`, level, mode };
      }
    }
  }
  return out;
}

function child(st: (typeof R10_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_R10_OFF: st.off,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r10-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  const stages: Record<string, Got>[] = Array.from({ length: R10_STAGES.length }, () => ({}));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < R10_STAGES.length) {
      const i = next++;
      stages[i] = await child(R10_STAGES[i]!);
      console.error(`stage ${R10_STAGES[i]!.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
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
    for (let i = 1; i < R10_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R10_STAGES[i]!.name);
    if (moved.length === 0) continue;
    stageOf[k] = moved.join("+");
    if (moved.includes("strings"))
      bad.push(`${k}: moved by strings in rc, which auto doesn't print`);
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
      if (EXACT.includes(id.split("#")[0]!)) continue;
      rows.push(`  ${JSON.stringify(id)}: ${JSON.stringify(s)},`);
    }
    const whys = R10_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r10-moved.ts"),
      `// Written by tools/r10-pins.ts --write: each pin R10 moved (SPEC M5's R10 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R10's changes is, by the name tools/r10-pins.ts's stages give it. */
export const R10_WHY: Record<string, string> = {
${whys}
};

export const R10_MOVED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R10 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r10Moved = (k: string): boolean =>
  Object.keys(R10_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r10-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r10-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
