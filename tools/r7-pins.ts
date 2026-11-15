// Which pinned tirhashes R7 moves (SPEC M5's R7 record, D36, D44, D73), and why. Every pin file is computed once per stage,
// each stage turning one more of R7's changes on (TMK_OPT_DISABLE for the pass, TMK_R7_OFF for the printer's, emit-tsl.ts):
//
//   none        all of R7 off: must give every pin as pinned, or as an earlier step listed it moved (maps-pins.ts's mapsMoved)
//   loopbounds  -O1's bounds checks a loop's own test proves (compiler/tir/passes/loopbounds.ts), on every TSL module
//   optfields   an optional number or boolean field printed as a `bool` flag field and a value field (class printing)
//   arrfields   a typed-array field printed as a runtime class of its pointer and length held in place, and a typed array's
//               pointer read for an element in class printing (class printing)
//   mapscross   a Map or Set crossing an export printed as JsMap or JsSet with D36's surface exports (class printing)
//
// The null check left to a load (compiler/backend-aarch64/shape.ts) is the backend's: it moves machine code, never TIR.
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else. For the pass, each
// such build is asked how many checks it removed (OptReport's loopBounds), which has to be at least one, and its level has
// to be -O1. For the printer's, each such build is one `auto` now prints with classes where it didn't (`tsl` set, nothing
// skipped), in `leak` or `manual`.
//
// `node tools/r7-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r7-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

export const R7_STAGES: { name: string; disable: string; off: string; why: string }[] = [
  { name: "none", disable: "loopbounds", off: "optfields,arrfields,mapscross", why: "" },
  {
    name: "loopbounds",
    disable: "",
    off: "optfields,arrfields,mapscross",
    why: "-O1 removes a bounds check its loop's own test proves (R7: loopbounds.ts): an index the loop variable is, or widens, compared below the same length",
  },
  {
    name: "optfields",
    disable: "",
    off: "arrfields,mapscross",
    why: "an optional number or boolean field printed as a bool flag field then its value field (R7, D62's first ruling), so auto prints with classes what stopped at it",
  },
  {
    name: "arrfields",
    disable: "",
    off: "mapscross",
    why: "a typed-array field printed as a runtime class of its pointer and length held in place, and a typed array's pointer read for an element (R7, D62's first ruling), so auto prints with classes what stopped at it",
  },
  {
    name: "mapscross",
    disable: "",
    off: "",
    why: "a Map or Set crossing an export printed as JsMap or JsSet with D36's surface exports (R7, D72)",
  },
];

interface Got {
  h: string;
  removed?: number; // loopBounds' checks removed, for the pass's stage
  classed?: boolean; // printed with classes through the TSL route
  level?: number;
  mode?: string;
}

/** Every pin's tirhash as the tree computes it with this process's environment, with what explains a move. */
async function computeAll(): Promise<Record<string, Got>> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  // `--only a.ts,b.ts` (TMK_R7_ONLY): just these programs' pins, for writing what a full run found moved
  const only =
    process.env.TMK_R7_ONLY !== undefined && process.env.TMK_R7_ONLY !== ""
      ? new Set(process.env.TMK_R7_ONLY.split(","))
      : null;
  const out: Record<string, Got> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const id = `${file}#${key}`;
      if (only !== null && !only.has(key.split("@")[0]!)) continue;
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
          const r = compileTyped(c.typed, { opt: level as 0 | 1 | 2 });
          out[id] = {
            h: r.tirHash,
            removed: r.opt.loopBounds.bounds + r.opt.loopBounds.branches,
            level,
            mode,
          };
        } else {
          const r = lowerFile(b.path, b.opts as never);
          out[id] = {
            h: r.tirHash,
            removed: (r.opt?.loopBounds.bounds ?? 0) + (r.opt?.loopBounds.branches ?? 0),
            // class printing taken: the TSL route's text, with no class printing skipped for phase 1's
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

function child(st: (typeof R7_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r7-child"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          TMK_OPT_DISABLE: st.disable,
          TMK_R7_OFF: st.off,
          TMK_OPT: "0",
          TMK_LEVEL_TRACE: "",
          TMK_R7_ONLY: onlyArg() ?? "",
        },
        maxBuffer: 512 << 20,
        timeout: 7_200_000,
      },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

function onlyArg(): string | undefined {
  const i = process.argv.indexOf("--only");
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  const stages: Record<string, Got>[] = Array.from({ length: R7_STAGES.length }, () => ({}));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < R7_STAGES.length) {
      const i = next++;
      stages[i] = await child(R7_STAGES[i]!);
      console.error(`stage ${R7_STAGES[i]!.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };
  // Two at a time: one compile each, so about two cores (one heavy job, as the round's rules ask).
  await Promise.all([worker(), worker()]);
  const pinned: Record<string, string> = {};
  const only = onlyArg() !== undefined ? new Set(onlyArg()!.split(",")) : null;
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin))
      if (only === null || only.has(k.split("@")[0]!)) pinned[`${file}#${k}`] = v;
  }
  const base = stages[0]!;
  const unexplained = Object.keys(pinned).filter(
    (k) => base[k]?.h !== pinned[k] && !mapsMoved(k.split("#")[1]!),
  );
  const stageOf: Record<string, string> = {};
  const bad: string[] = [];
  for (const k of Object.keys(pinned)) {
    const moved: string[] = [];
    for (let i = 1; i < R7_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R7_STAGES[i]!.name);
    if (moved.length === 0) continue;
    stageOf[k] = moved.join("+");
    for (const s of moved) {
      const i = R7_STAGES.findIndex((x) => x.name === s);
      const g = stages[i]!;
      // The pass: an -O1 build that removed at least one check. The printer's: a leak or manual build now printed with
      // classes where the stage before didn't.
      if (s === "loopbounds" && !(g[k]?.level === 1 && (g[k]?.removed ?? 0) > 0))
        bad.push(
          `${k}: moved by loopbounds, but at -O${g[k]?.level} with ${g[k]?.removed} removed`,
        );
      if (
        s !== "loopbounds" &&
        !(
          (g[k]?.mode === "leak" || g[k]?.mode === "manual") &&
          g[k]?.classed === true &&
          stages[i - 1]![k]?.classed !== true
        )
      )
        bad.push(`${k}: moved by ${s}, but not a build that now prints with classes`);
    }
  }
  const last = stages[stages.length - 1]!;
  const byStage: Record<string, number> = {};
  for (const s of Object.values(stageOf)) byStage[s] = (byStage[s] ?? 0) + 1;
  const programs: Record<string, Set<string>> = {};
  for (const [k, s] of Object.entries(stageOf)) {
    const f = k.split("#")[1]!.split("@")[0]!;
    (programs[s] ??= new Set()).add(f);
  }
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
      const [file] = id.split("#") as [string, string];
      if (EXACT.includes(file)) continue;
      const g = last[id]!;
      const n = s.includes("loopbounds") ? `${g.removed} checks removed at -O${g.level}` : "";
      rows.push(
        `  ${JSON.stringify(id)}: [${JSON.stringify(s)}${n !== "" ? `, ${JSON.stringify(n)}` : ""}],`,
      );
    }
    const whys = R7_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r7-moved.ts"),
      `// Written by tools/r7-pins.ts --write: each pin R7 moved (SPEC M5's R7 record), by pin file and key, with the change that
// moved it and, for -O1's loop bounds proof, how many checks the build's optimiser removed. maps-tirhash.json and
// pipe-tirhash.json are pinned again instead.

/** What each of R7's changes is, by the name tools/r7-pins.ts's stages give it. */
export const R7_WHY: Record<string, string> = {
${whys}
};

export const R7_MOVED: Record<string, [string, string?]> = {
${rows.join("\n")}
};

/** A pin R7 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r7Moved = (k: string): boolean =>
  Object.keys(R7_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r7-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r7-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
