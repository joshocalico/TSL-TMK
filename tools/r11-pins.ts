// Which pinned tirhashes R11 moves (SPEC M5's R11 record, 3.5, D39, D49, D68, D72, D74), and why. Every pin file is
// computed once per stage, each stage turning one more of R11's changes on (TMK_R11_OFF, a list, turns the compiler's off;
// TSL_TEST_PATCH puts the three library modules back as they were before R11):
//
//   none      all of R11 off, the libraries as they were: must give every pin as pinned, or as an earlier step listed it
//   lib       @tsl/jsrt's JsMap (`tablesIn`, a counted flag, resize's steps and drain) and JsArray (`tryReserve`), and
//             @tsl/gc's `rcAllocSteps`, with nothing printed calling them yet
//   tables    in `rc`, a map's holder printed with `tablesIn(rcAllocSteps, rcCollect)` (emit-tsl.ts)
//   mapsteps  in `rc`, a map holding nothing counted freed in one step, not one a position (expand-rc.ts)
//   never     in `rc`, a call that never returns ending its statement list, and a local's definite assignment kept
//   unset     in `rc`, a field declared assigned with no initialiser visited as nullable when its object is freed
//   narrow    in `rc`, module state counted by its declared type, not as tsc narrows it after an assignment
//   args      in `rc`, arguments before one that needs a statement first evaluated into locals, where it refused
//   exc       exceptions in `rc` printed (no longer refused by name), which `auto` doesn't take (AUTO_RC_EXC): must move
//             nothing
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else.
//
// `node tools/r11-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r11-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

const ALL = "tables,mapsteps,never,unset,narrow,args,exc";

/** The three library modules as they were before R11 (SPEC.md.bak-pre-r11's blocks), put back by TSL_TEST_PATCH. */
function libUndo(): string {
  const { readFileSync: rf } = { readFileSync };
  const blocks = new Map<string, string>();
  const spec = rf(join(ROOT, "SPEC.md.bak-pre-r11"), "utf8");
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g))
    blocks.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  const out: { file: string; from: string; to: string }[] = [];
  for (const [dir, f] of [
    ["packages/tsl-jsrt", "ex-jsrt-map.ts"],
    ["packages/tsl-jsrt", "ex-jsrt-array.ts"],
    ["packages/tsl-gc", "ex-gc-rc.ts"],
  ] as const) {
    const now = rf(join(ROOT, dir, f), "utf8");
    const was = blocks.get(f)!;
    if (now !== was) out.push({ file: `${dir}/${f}`, from: now, to: was });
  }
  // and the two front doors' new exports
  out.push(
    { file: "packages/tsl-gc/index.ts", from: "  rcAllocSteps,\n", to: "" },
    { file: "packages/tsl-jsrt/index.ts", from: "  type TableSteps,\n", to: "" },
  );
  return JSON.stringify(out);
}

export const R11_STAGES: { name: string; off: string; why: string; undo?: true }[] = [
  { name: "none", off: ALL, why: "", undo: true },
  {
    name: "lib",
    off: ALL,
    why: "@tsl/jsrt's JsMap and JsArray and @tsl/gc gain R11's table pacing (tablesIn, tryReserve, rcAllocSteps), nothing printed calling it yet (R11)",
  },
  {
    name: "tables",
    off: "mapsteps,never,unset,narrow,args,exc",
    why: "in rc, a map's holder printed with tablesIn(rcAllocSteps, rcCollect): each table made at the counted heap's pace (R11)",
  },
  {
    name: "mapsteps",
    off: "never,unset,narrow,args,exc",
    why: "in rc, a map holding nothing counted freed in one step, not one a position (R11)",
  },
  {
    name: "never",
    off: "unset,narrow,args,exc",
    why: "in rc, a call that never returns ending its statement list, and a local's definite assignment kept (R11)",
  },
  {
    name: "unset",
    off: "narrow,args,exc",
    why: "in rc, a field declared assigned with no initialiser visited as nullable when its object is freed (R11)",
  },
  {
    name: "narrow",
    off: "args,exc",
    why: "in rc, module state counted by its declared type, not as tsc narrows it after an assignment (R11)",
  },
  {
    name: "args",
    off: "exc",
    why: "in rc, arguments before one that needs a statement first evaluated into locals, in order, where the expansion refused the call (R11)",
  },
  {
    name: "exc",
    off: "",
    why: "exceptions in rc printed through the TSL route, which auto doesn't take (AUTO_RC_EXC, R11)",
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

function child(st: (typeof R11_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_R11_OFF: st.off,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    if (st.undo === true) env.TSL_TEST_PATCH = libUndo();
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r11-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  const stages: Record<string, Got>[] = Array.from({ length: R11_STAGES.length }, () => ({}));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < R11_STAGES.length) {
      const i = next++;
      stages[i] = await child(R11_STAGES[i]!);
      console.error(`stage ${R11_STAGES[i]!.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
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
    for (let i = 1; i < R11_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R11_STAGES[i]!.name);
    if (moved.length === 0) continue;
    stageOf[k] = moved.join("+");
    if (moved.includes("exc")) bad.push(`${k}: moved by exceptions in rc, which auto doesn't take`);
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
        movedKeys: stageOf,
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
    const whys = R11_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r11-moved.ts"),
      `// Written by tools/r11-pins.ts --write: each pin R11 moved (SPEC M5's R11 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R11's changes is, by the name tools/r11-pins.ts's stages give it. */
export const R11_WHY: Record<string, string> = {
${whys}
};

export const R11_MOVED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R11 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r11Moved = (k: string): boolean =>
  Object.keys(R11_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r11-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r11-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
