// Which pinned tirhashes R14 moves (SPEC M5's R14 record, D62, pile item 9), and why. Every pin file is computed once per
// stage, each stage turning one more of R14's changes on (TMK_R14_OFF, a list, turns the compiler's off):
//
//   none      all of R14 off: must give every pin as pinned, or as an earlier step listed it
//   inv       phase 1's printing notes a class id's load invariant (`load<i32>(o, 0, "invariant")`, D73), as the direct route
//             notes it: only -O1 and -O2 TIR can move (-O0's text leaves the mark out), and only towards the direct route's
//   trust     `auto` takes a printing reshaped only by the kinds it trusts, in the printings it trusts them in (tslc.ts's
//             TRUSTED_RESHAPES and TRUSTED_IN: phase 1's), whose TIR is the direct route's
//
// R14's other changes move nothing by construction, and the `none` stage shows it: the injected bugs (TMK_TEST_EMIT only),
// the emit stats' `classes`, the driver's timing passes (a timing image only) and the tools.
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else.
//
// `node tools/r14-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r14-moved.ts for the rest.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, EXACT, FILES } from "./r6-pins.ts";

const ALL = "trust,inv";

export const R14_STAGES: { name: string; off: string; why: string }[] = [
  { name: "none", off: ALL, why: "" },
  {
    name: "inv",
    off: "trust",
    why: "phase 1's printing notes a class id's load invariant (load<i32>(o, 0, \"invariant\"), D73) as the direct route notes it, so -O1's and -O2's TIR is the direct route's (R14)",
  },
  {
    name: "trust",
    off: "",
    why: "auto takes a program phase 1 printed reshaped only by the kinds it trusts (a statement-expression's statements before an operand, after a sequence's first part, in a conditional's arm, on a logical operator's right side), whose TIR is the direct route's (R14)",
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

function child(st: (typeof R14_STAGES)[number]): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_R14_OFF: st.off,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    delete env.TMK_EMIT_STRICT;
    delete env.TMK_EMIT_STRICT_ARRAYS;
    delete env.TMK_TRUST_RESHAPES;
    delete env.TMK_TEST_EMIT;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r14-child"],
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
  for (const st of R14_STAGES) stages.push(await child(st));
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
    for (let i = 1; i < R14_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R14_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // Only lowered builds in `strict`, `leak` and `manual` may move (`rc` has no phase 1 printing), `inv` only at -O1 and
  // -O2, and none of TSL proper's (the kernel's language is as it was).
  const bad = Object.keys(stageOf).filter(
    (k) =>
      last[k]?.mode === "rc" ||
      (stageOf[k]!.includes("inv") && (last[k]?.level ?? 0) === 0) ||
      buildOf(k.split("#")[0]!, k.split("#")[1]!).tslProper,
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
    const whys = R14_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r14-moved.ts"),
      `// Written by tools/r14-pins.ts --write: each pin R14 moved (SPEC M5's R14 record), by pin file and key, with the change that
// moved it. maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R14's changes is, by the name tools/r14-pins.ts's stages give it. */
export const R14_WHY: Record<string, string> = {
${whys}
};

export const R14_MOVED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R14 moved, by its key (\`file@mode@O1\` and the like), in any pin file. */
export const r14Moved = (k: string): boolean =>
  Object.keys(R14_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: tools/maps-pins.ts imports tools/r14-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r14-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
