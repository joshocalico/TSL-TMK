// Which pinned -O1 and -O2 tirhashes R1f's strength reduction moves (SPEC 4.3's `simplify`, M5's R1f record), each with its
// cause. Modelled on tools/clsid-pins.ts.
//
// Every pin file with -O1 or -O2 entries is computed twice: with the rules off (`TMK_TSL_OPT_OFF=pow2,bigshift`), which must
// give every pin as it was (or as the steps before listed it moved), and with them on. A pin that differs moved by this step:
// its -O1 or -O2 TIR has an unsigned division or remainder by a power of two as a shift or an `and`, a 64-bit shift by a
// constant without its guard, or a checked `<<` whose test for bits lost folded. R1f's other changes are to @tsl/gc's
// library and its intrinsic `slotOfLive`, which only TSL `rc` programs and hand-written `Rc` users link, and none of those is
// pinned by tirhash: the computation with the rules off showing every pin as pinned is what shows that. -O0 is untouched by
// construction, as `simplify` doesn't run there.
//
// `node tools/r1f-pins.ts [--write]`: prints what moved, as JSON; with --write, pins the moved ones again in the files
// compared exactly, and writes tools/r1f-moved.ts for the rest. Each computation runs in a process of its own.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

/** Compared exactly by their boxes (pipe-a box 7): pinned again where phase B moved them. */
const EXACT = ["corpus/memory/maps-tirhash.json", "corpus/memory/pipe-tirhash.json"];

const FILES = [
  "corpus/memory/opt-tirhash.json",
  "corpus/memory/lang-a-tirhash.json",
  "corpus/memory/maps-tirhash.json",
  "corpus/memory/pipe-tirhash.json",
];
const { mapsMoved } = await import("./maps-pins.ts");

/** The two computations: with the step off, and on. */
export const STAGES: { name: string; off: string }[] = [
  { name: "none", off: "pow2,bigshift" },
  { name: "strength", off: "" },
];

/** Every -O1 and -O2 pin's tirhash as the tree computes it now, with the environment it runs in. */
async function computeAll(): Promise<Record<string, string>> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const out: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const m = /^(.*?)(?:@([a-z+]+))?@O([12])$/.exec(key);
      if (m === null) continue;
      const [, f, mode, lvl] = m as unknown as [string, string, string | undefined, string];
      const opt = Number(lvl) as 1 | 2;
      const path = join(ROOT, f);
      let h: string;
      if (mode === undefined) {
        const c = checkFile(path);
        h =
          c.typed === null
            ? `diags:${c.diags.map((x) => x.code).join()}`
            : compileTyped(c.typed, { opt }).tirHash;
      } else if (file.includes("pipe-tirhash")) {
        h = lowerFile(path, { memory: mode, opt, route: "tsl" }).tirHash;
      } else if (mode === "strict") h = lowerFile(path, { opt }).tirHash;
      else if (mode === "rc+check")
        h = lowerFile(path, { memory: "rc", rc: { check: true, account: true }, opt }).tirHash;
      else if (mode === "rc+off")
        h = lowerFile(path, { memory: "rc", rc: { cycles: false }, opt }).tirHash;
      else h = lowerFile(path, { memory: mode, opt }).tirHash;
      out[`${file}#${key}`] = h;
    }
  }
  return out;
}

const stages0 = STAGES;

if (process.argv.includes("--child")) {
  process.stdout.write(JSON.stringify(await computeAll()));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  // Each stage in a process of its own, all at once.
  const t0 = Date.now();
  const stages = await Promise.all(
    stages0.map(
      (st) =>
        new Promise<Record<string, string>>((done, fail) => {
          execFile(
            process.execPath,
            ["--no-warnings", import.meta.filename, "--child"],
            {
              cwd: ROOT,
              env: {
                ...process.env,
                TMK_TSL_OPT_OFF: st.off,
                TMK_OPT: "",
              },
              maxBuffer: 256 << 20,
              timeout: 3_600_000,
            },
            (err, out) => {
              if (err !== null) fail(err);
              else {
                console.error(`stage ${st.name}: ${Date.now() - t0} ms`);
                done(JSON.parse(out) as Record<string, string>);
              }
            },
          );
        }),
    ),
  );
  const pinned: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin)) pinned[`${file}#${k}`] = v;
  }
  // The baseline is the tree with the rules off: a pin that differs from it must have been moved before, and be listed by
  // the step that moved it (tools/maps-pins.ts's mapsMoved); anything else is a move R1f made some other way.
  const base = stages[0]!;
  const unexplained = Object.keys(base).filter((k) => {
    const key = k.split("#")[1]!;
    return base[k] !== pinned[k] && !mapsMoved(key);
  });
  const moved: Record<string, string[]> = {};
  const passOf: Record<string, string> = {};
  for (const k of Object.keys(base)) {
    for (let i = 1; i < stages0.length; i++) {
      if (stages[i]![k] !== stages[i - 1]![k]) {
        (moved[stages0[i]!.name] ??= []).push(k);
        passOf[k] = stages0[i]!.name;
        break;
      }
    }
  }
  const last = stages[stages.length - 1]!;
  console.log(
    JSON.stringify(
      {
        total: Object.keys(last).length,
        movedByStrength: Object.keys(passOf).length,
        unexplained,
        byPass: Object.fromEntries(Object.entries(moved).map(([p, ks]) => [p, ks.length])),
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(passOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
      },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write") && unexplained.length === 0) {
    // The files compared exactly are pinned again where this step moved them; the others' checks take the list.
    for (const file of EXACT) {
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const pin = JSON.parse(text) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const id = `${file}#${k}`;
        // A pin this step moves is pinned at what the tree gives now.
        if (passOf[id] !== undefined) pin[k] = last[id]!;
      }
      const indent = /\n( +)"/.exec(text)?.[1] ?? " ";
      writeFileSync(path, `${JSON.stringify(pin, null, indent.length)}\n`);
    }
    const why =
      "R1f's strength reduction (4.3's simplify): an unsigned division or remainder by a power of two a shift or an and, a 64-bit shift by a constant unguarded, a checked << whose test for bits lost folds";
    const keys = new Set<string>();
    for (const id of Object.keys(passOf)) {
      const [file, key] = id.split("#") as [string, string];
      if (!EXACT.includes(file)) keys.add(key);
    }
    const lines = [...keys].sort().map((k) => `  ${JSON.stringify(k)},`);
    writeFileSync(
      join(ROOT, "tools/r1f-moved.ts"),
      `// Written by tools/r1f-pins.ts --write: each -O1 and -O2 pin that R1f's strength reduction moved (SPEC 4.3's simplify,
// M5's R1f record), by its key. Nothing at -O0 moves.
export const R1F_WHY =
  ${JSON.stringify(why)};

export const R1F_MOVED: ReadonlySet<string> = new Set([
${lines.join("\n")}
]);

/** A -O1 or -O2 pin R1f's strength reduction moved, as listed. */
export const r1fMoved = (k: string): boolean => /@O[12]$/.test(k) && R1F_MOVED.has(k);
`,
    );
  }
}
