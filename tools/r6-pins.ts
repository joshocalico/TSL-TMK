// Which pinned tirhashes R6 moves (SPEC M5's R6 record, D36, D62), and why. Every pin file is computed once per stage, each
// stage turning one more of R6's changes on (TMK_R6_OFF lists what's still off, down-model.ts's r6Off):
//
//   none      all of R6 off: must give every pin as pinned, or as an earlier step listed it moved (maps-pins.ts's mapsMoved)
//   layout    D36 moved to TSL's own layout (a bool a byte, an optional scalar a bool flag then its value, an object's size
//             rounded to its alignment only): what the direct route and phase 1's printing lay out, and the native ABI
//   checks    a vector read's bounds check printed as JsArray's `get` alone, and the source's `!` on a read as TSL's own `!`
//             where `nonNull(…)!` made two null checks (class printing only)
//   region    tslc's per-call region (region.ts): a heap `new` no export call outlives in the call arena, which each export
//             gives back at its returns (class printing in leak and manual only)
//   closures  `auto` prints closure values as environment classes in leak and manual too (AUTO_CLOSURES)
//   boundary  `auto` prints exported functions taking or giving objects (AUTO_BOUNDARY)
//
// A pin that differs between two stages moved by the change the later one turns on, and by nothing else, since the stages
// differ in nothing else. For a pin the layout moved, the build's own lowering is asked what in it D36's old rule and TSL's
// lay out differently (down-model.ts's layoutNotes): every such pin has to name at least one thing, which shows the
// layout moved only builds whose objects (or vectors, or module state) it lays out.
//
// `node tools/r6-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained, pins the moved ones
// again in the files compared exactly (maps-tirhash.json, pipe-tirhash.json) and writes tools/r6-moved.ts for the rest.
// Each stage runs in a process of its own, four at a time.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

/** Compared exactly by their boxes (pipe-a box 7, maps): pinned again where R6 moved them. */
export const EXACT = ["corpus/memory/maps-tirhash.json", "corpus/memory/pipe-tirhash.json"];

export const FILES = [
  "corpus/memory/pre-std-tirhash.json",
  "corpus/memory/strict-tirhash.json",
  "corpus/memory/modes-tirhash.json",
  "corpus/memory/rc-off-tirhash.json",
  "corpus/memory/pre-strings-tirhash.json",
  "corpus/memory/opt-tirhash.json",
  "corpus/memory/maps-tirhash.json",
  "corpus/memory/lang-a-tirhash.json",
  "corpus/memory/pipe-tirhash.json",
];

export const R6_STAGES: { name: string; off: string; why: string; jsrt?: false }[] = [
  { name: "none", off: "layout,checks,region,closures,boundary", why: "", jsrt: false },
  {
    name: "jsrt",
    off: "layout,checks,region,closures,boundary",
    why: "@tsl/jsrt's source changed (R6): JsArray's growth asks whether the array is in the per-call region (inCallRegion), which a build with nothing there answers with a constant, and JsMap's scratch word traps 14 when the global allocator has none",
  },
  {
    name: "layout",
    off: "checks,region,closures,boundary",
    why: "D36 moved to TSL's own layout, per the owner's ruling (D62, R6): a bool a byte, an optional scalar a bool flag then its value, an object's size rounded to its alignment only; the build lays out an object, vector or module state that way",
  },
  {
    name: "checks",
    off: "region,closures,boundary",
    why: "a vector read's bounds check printed as JsArray's get alone, and the source's ! on a read as TSL's own checked ! (R6: one check of each where -O1 made two)",
  },
  {
    name: "region",
    off: "closures,boundary",
    why: "tslc's per-call region (R6, region.ts): a heap new no export call outlives placed in the call arena, which each export gives back at its returns",
  },
  {
    name: "closures",
    off: "boundary",
    why: "auto prints closure values as environment classes in leak and manual (R6: AUTO_CLOSURES), where the direct route built them",
  },
  {
    name: "boundary",
    off: "",
    why: "auto prints an exported function taking or giving an object with classes (R6: AUTO_BOUNDARY), in D36's listed layout, where phase 1's printing built it",
  },
];

/** How a pin's key is built, by its file: the options lowerFile or compileTyped takes, or null for TSL proper. */
export function buildOf(
  file: string,
  key: string,
): { path: string; tslProper: boolean; opts: Record<string, unknown> } {
  const m = /^(.*?\.ts)(?:@([a-z+]+))?(?:@O([012]))?$/.exec(key);
  if (m === null) throw new Error(`a pin key r6-pins can't read: ${key}`);
  const [, f, mode, lvl] = m as unknown as [string, string, string | undefined, string | undefined];
  const opt = lvl !== undefined ? Number(lvl) : 0;
  const path = join(ROOT, f);
  const rcOff = file.includes("rc-off");
  if (mode === undefined) {
    // pre-std's, strict's, modes', pre-strings' and opt's TSL proper programs; strict's lowered ones by file name
    const lowered = file.includes("strict-tirhash") && /corpus\/(lower|native)\//.test(f);
    return lowered
      ? { path, tslProper: false, opts: { opt } }
      : { path, tslProper: true, opts: { opt } };
  }
  const base: Record<string, unknown> = { opt };
  if (file.includes("pipe-tirhash"))
    return { path, tslProper: false, opts: { ...base, memory: mode, route: "tsl" } };
  if (mode === "strict") return { path, tslProper: false, opts: base };
  if (mode === "rc+check")
    return {
      path,
      tslProper: false,
      opts: {
        ...base,
        memory: "rc",
        rc: { ...(rcOff ? { cycles: false } : {}), check: true, account: true },
      },
    };
  if (mode === "rc+off")
    return { path, tslProper: false, opts: { ...base, memory: "rc", rc: { cycles: false } } };
  if (mode === "rc" && rcOff)
    return { path, tslProper: false, opts: { ...base, memory: "rc", rc: { cycles: false } } };
  return { path, tslProper: false, opts: { ...base, memory: mode } };
}

/** Every pin's tirhash as the tree computes it with this process's environment; with `notes`, what layoutNotes says. */
async function computeAll(
  only?: Set<string>,
): Promise<Record<string, { h: string; notes?: string[] }>> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const { layoutNotes } = await import("../compiler/host/down-model.ts");
  const out: Record<string, { h: string; notes?: string[] }> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const id = `${file}#${key}`;
      if (only !== undefined && !only.has(id)) continue;
      const b = buildOf(file, key);
      let h: string;
      layoutNotes.clear();
      try {
        if (b.tslProper) {
          const c = checkFile(b.path);
          h =
            c.typed === null
              ? `diags:${c.diags.map((x) => x.code).join()}`
              : compileTyped(c.typed, { opt: b.opts.opt as 0 | 1 | 2 }).tirHash;
        } else h = lowerFile(b.path, b.opts as never).tirHash;
      } catch (e) {
        h = `threw:${String(e).slice(0, 80)}`;
      }
      out[id] = only !== undefined ? { h, notes: [...layoutNotes].sort() } : { h };
    }
  }
  return out;
}

/**
 * @tsl/jsrt's two modules as they were before R6, from SPEC.md.bak-pre-r6's `// file:` blocks, as TSL_TEST_PATCH puts them
 * back: each whole file for the text it had.
 */
function jsrtAsBefore(): string {
  const block = (spec: string, name: string): string => {
    const m = new RegExp(`\`\`\`ts\n(// file: ${name.replace(".", "\\.")}\n[\\s\\S]*?)\`\`\``).exec(
      spec,
    );
    if (m === null) throw new Error(`no ${name} block`);
    return m[1]!;
  };
  const old = readFileSync(join(ROOT, "SPEC.md.bak-pre-r6"), "utf8");
  return JSON.stringify(
    ["ex-jsrt-array.ts", "ex-jsrt-map.ts"].map((name) => ({
      file: `packages/tsl-jsrt/${name}`,
      from: readFileSync(join(ROOT, "packages/tsl-jsrt", name), "utf8"),
      to: block(old, name),
    })),
  );
}

function child(off: string, args: string[], jsrt = true): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, ...args],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          TMK_R6_OFF: off,
          TMK_OPT: "0",
          TMK_LEVEL_TRACE: "",
          ...(jsrt ? {} : { TSL_TEST_PATCH: jsrtAsBefore() }),
        },
        maxBuffer: 512 << 20,
        timeout: 7_200_000,
      },
      (err, out) => (err !== null ? fail(err) : done(out)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  // Four stages at a time, each a process of its own: one compile each, so about four cores.
  const stages: Record<string, string>[] = Array.from({ length: R6_STAGES.length }, () => ({}));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < R6_STAGES.length) {
      const i = next++;
      const st = R6_STAGES[i]!;
      const got = JSON.parse(await child(st.off, ["--r6-child"], st.jsrt !== false)) as Record<
        string,
        { h: string }
      >;
      stages[i] = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.h]));
      console.error(`stage ${st.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const pinned: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin)) pinned[`${file}#${k}`] = v;
  }
  // The baseline is R6 off: what differs from the pins there must have been moved before, and be listed by the step that
  // moved it; anything else moved some other way.
  const base = stages[0]!;
  const unexplained = Object.keys(pinned).filter(
    (k) => base[k] !== pinned[k] && !mapsMoved(k.split("#")[1]!),
  );
  const stageOf: Record<string, string> = {};
  for (const k of Object.keys(pinned)) {
    for (let i = 1; i < R6_STAGES.length; i++) {
      if (stages[i]![k] !== stages[i - 1]![k]) {
        stageOf[k] = R6_STAGES[i]!.name;
        break;
      }
    }
    // A pin moved by two changes is listed by the first; the later ones are said too.
    const later: string[] = [];
    for (let i = 1; i < R6_STAGES.length; i++)
      if (stages[i]![k] !== stages[i - 1]![k] && R6_STAGES[i]!.name !== stageOf[k])
        later.push(R6_STAGES[i]!.name);
    if (later.length > 0) stageOf[k] = [stageOf[k], ...later].join("+");
  }
  // What the layout moved: each build asked what in it the two rules lay out differently.
  const layoutMoved = Object.keys(stageOf).filter((k) => stageOf[k]!.split("+").includes("layout"));
  const notes =
    layoutMoved.length > 0
      ? (JSON.parse(
          await child("checks,region,closures,boundary", [
            "--r6-notes",
            JSON.stringify(layoutMoved),
          ]),
        ) as Record<string, { h: string; notes: string[] }>)
      : {};
  const noNote = layoutMoved.filter((k) => (notes[k]?.notes.length ?? 0) === 0);
  const last = stages[stages.length - 1]!;
  const byStage: Record<string, number> = {};
  for (const s of Object.values(stageOf)) byStage[s] = (byStage[s] ?? 0) + 1;
  const programs: Record<string, Set<string>> = {};
  for (const [k, s] of Object.entries(stageOf)) {
    const f = k.split("#")[1]!.split("@")[0]!;
    (programs[s] ??= new Set()).add(f);
  }
  const noteKinds: Record<string, number> = {};
  for (const k of layoutMoved)
    for (const n of notes[k]?.notes ?? []) noteKinds[n] = (noteKinds[n] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        unexplained,
        layoutWithoutNote: noNote,
        byStage,
        programsByStage: Object.fromEntries(
          Object.entries(programs).map(([s, f]) => [s, [...f].sort()]),
        ),
        layoutNotes: noteKinds,
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(stageOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
        unmovedTslProper: Object.keys(pinned).filter(
          (k) => buildOf(k.split("#")[0]!, k.split("#")[1]!).tslProper && stageOf[k] === undefined,
        ).length,
        movedTslProper: Object.keys(stageOf).filter(
          (k) => buildOf(k.split("#")[0]!, k.split("#")[1]!).tslProper,
        ),
      },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write") && unexplained.length === 0 && noNote.length === 0) {
    for (const file of EXACT) {
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const pin = JSON.parse(text) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const id = `${file}#${k}`;
        if (stageOf[id] !== undefined) pin[k] = last[id]!;
      }
      const indent = /\n( +)"/.exec(text)?.[1] ?? " ";
      writeFileSync(path, `${JSON.stringify(pin, null, indent.length)}\n`);
    }
    // The rest, by key with its reason: each pin file's key, as the checks that use mapsMoved see it.
    const rows: string[] = [];
    const seen = new Set<string>();
    for (const [id, s] of Object.entries(stageOf).sort()) {
      const [file, key] = id.split("#") as [string, string];
      if (EXACT.includes(file)) continue;
      const k = `${file}#${key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const n = notes[id]?.notes;
      rows.push(
        `  ${JSON.stringify(k)}: [${JSON.stringify(s)}${n !== undefined && n.length > 0 ? `, ${JSON.stringify(n.join("; "))}` : ""}],`,
      );
    }
    const whys = R6_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r6-moved.ts"),
      `// Written by tools/r6-pins.ts --write: each pin R6 moved (SPEC M5's R6 record), by pin file and key, with the change that
// moved it and, for the layout, what in the build D36's old rule and TSL's lay out differently (down-model.ts's
// layoutNotes). maps-tirhash.json and pipe-tirhash.json are pinned again instead.

/** What each of R6's changes is, by the name tools/r6-pins.ts's stages give it. */
export const R6_WHY: Record<string, string> = {
${whys}
};

export const R6_MOVED: Record<string, [string, string?]> = {
${rows.join("\n")}
};

/** Why a pin moved, by the stages that moved it (\`layout+region\`: both). */
export const r6Why = (stage: string): string =>
  stage
    .split("+")
    .map((s) => R6_WHY[s] ?? s)
    .join("; and ");

/** A pin R6 moved, by its key (\`file@mode@O2\` and the like), in any pin file. */
export const r6Moved = (k: string): boolean =>
  Object.keys(R6_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by flags of its own: tools/maps-pins.ts imports tools/r6-moved.ts, never this.
if (import.meta.main && process.argv.includes("--r6-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main && process.argv.includes("--r6-notes")) {
  const ids = new Set(
    JSON.parse(process.argv[process.argv.indexOf("--r6-notes") + 1]!) as string[],
  );
  void computeAll(ids).then((o) => process.stdout.write(JSON.stringify(o)));
} else if (import.meta.main) void main();
