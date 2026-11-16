// Which pinned tirhashes R13 moves (SPEC M5's R13 record, D62, D66, pile item 7), and why. Every pin file is computed once
// per stage, each stage turning one more of R13's changes on (TMK_R13_OFF, a list, turns the compiler's off):
//
//   none      all of R13 off: must give every pin as pinned, or as an earlier step listed it
//   arena     in `strict`'s call arena, what an export gives or is given lives until the caller resets the arena (D36), and
//             module state is long only where something made after `__init` can reach it (region.ts's stateHazard)
//   arrays    `auto`'s class printing in `strict` prints arrays as @tsl/jsrt's arena array and typed arrays made in functions
//             as R9's views, where the printing is exact (tslc.ts's AUTO_STRICT_ARRAYS)
//
// R13's other changes move nothing by construction, and the `none` stage shows it: closure values and exports taking or
// giving objects printed in `strict` (only where the route is forced: `auto` takes them as it does in every mode), a typed
// array's pointer against null and a null one made in `strict` (`nullRef()`, where `null` didn't compile), the Wasm glue's
// i64 references, the arena array's module and @tsl/unsafe's host `callRegionBytes` (nothing is compiled from them where
// nothing prints the class), and the fence on @tsl/jsrt/arena (a diagnostic).
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else.
//
// `node tools/r13-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r13-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

const ALL = "arrays,arena,boundary,closures";

export const R13_STAGES: { name: string; off: string; why: string }[] = [
  { name: "none", off: ALL, why: "" },
  {
    name: "arena",
    off: "arrays,boundary,closures",
    why: "in strict's call arena, what an export gives or is given lives until the caller resets it (D36), and module state is long only where something made after __init can reach it (R13)",
  },
  {
    name: "arrays",
    off: "",
    why: "in strict, auto's class printing prints arrays as @tsl/jsrt's arena array (JsArenaArray, its buffers the call arena's) and typed arrays made in functions as R9's views, where the printing is exact (R13)",
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

function child(st: (typeof R13_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_R13_OFF: st.off,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    delete env.TMK_EMIT_STRICT;
    delete env.TMK_EMIT_STRICT_ARRAYS;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r13-child"],
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
  for (const st of R13_STAGES) stages.push(await child(st));
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
    for (let i = 1; i < R13_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R13_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // Only `strict` builds may move, and none of TSL proper's (the kernel's language is as it was).
  const bad = Object.keys(stageOf).filter(
    (k) => last[k]?.mode !== "strict" || buildOf(k.split("#")[0]!, k.split("#")[1]!).tslProper,
  );
  const programs = [...new Set(Object.keys(stageOf).map((k) => k.split("#")[1]!.split("@")[0]!))];
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        unexplained,
        bad,
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
    const whys = R13_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r13-moved.ts"),
      `// Written by tools/r13-pins.ts --write: each pin R13 moved (SPEC M5's R13 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R13's changes is, by the name tools/r13-pins.ts's stages give it. */
export const R13_WHY: Record<string, string> = {
${whys}
};

export const R13_MOVED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R13 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r13Moved = (k: string): boolean =>
  Object.keys(R13_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r13-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r13-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
