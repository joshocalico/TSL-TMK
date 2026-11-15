// Which pinned -O1 and -O2 tirhashes optimiser phase B moves, and which pass moved each (SPEC M5's phase B record, D73).
//
// Every pin file with -O1 or -O2 entries is computed again with phase B's passes switched on one stage at a time, in the
// order they run: none (which must give every pin as it was, or something else moved it), then value numbering, then
// loop-invariant code motion, then unswitching and peeling, then check elimination. A pin moved by a stage is put down to
// that stage's pass, the first that moved it. -O0 is untouched by construction (the optimiser returns its input), and its
// pins are the gate's own boxes.
//
// `node tools/opt-b-pins.ts [--write]`: prints what moved, by pass, as JSON; with --write, pins the moved ones again, in
// place, nothing else changed in their files. Each stage runs in a process of its own, all at once, with TMK_OPT_DISABLE set.
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

/** The stages, each the passes still off. */
export const STAGES: { name: string; off: string[] }[] = [
  { name: "none", off: ["gvn", "licm", "unswitch", "peel", "checks"] },
  { name: "gvn", off: ["licm", "unswitch", "peel", "checks"] },
  { name: "licm", off: ["unswitch", "peel", "checks"] },
  { name: "unswitch and peel", off: ["checks"] },
  { name: "checks", off: [] },
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

const { PASSES } = await import("../compiler/tir/passes/manager.ts");
const known = new Set<string>(PASSES);
// Only the stages whose passes are built: B1 has no check elimination yet.
const stages0 = STAGES.filter(
  (s) => s.name === "none" || s.name.split(" and ").every((p) => known.has(p)),
);

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
                TMK_OPT_DISABLE: st.off.filter((p) => known.has(p)).join(","),
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
  // The baseline is the tree with phase B off: pins that differ from it already were moved before, and are listed by
  // the steps that moved them (tools/maps-pins.ts's mapsMoved).
  const base = stages[0]!;
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
        movedByPhaseB: Object.keys(passOf).length,
        byPass: Object.fromEntries(Object.entries(moved).map(([p, ks]) => [p, ks.length])),
        byFile: Object.fromEntries(
          FILES.map((f) => [f, Object.keys(passOf).filter((k) => k.startsWith(`${f}#`)).length]),
        ),
      },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write")) {
    // The files compared exactly are pinned again where phase B moved them; the others' checks take the list.
    for (const file of EXACT) {
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const pin = JSON.parse(text) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const id = `${file}#${k}`;
        // Whatever it was pinned at before (with phase B off, or by an earlier run of this on earlier code), a pin phase B
        // moves is pinned at what the tree gives now.
        if (passOf[id] !== undefined) pin[k] = last[id]!;
      }
      const indent = /\n( +)"/.exec(text)?.[1] ?? " ";
      writeFileSync(path, `${JSON.stringify(pin, null, indent.length)}\n`);
    }
    const byKey: Record<string, string> = {};
    for (const [id, pass] of Object.entries(passOf)) {
      const [file, key] = id.split("#") as [string, string];
      if (EXACT.includes(file)) continue;
      byKey[key] =
        byKey[key] === undefined || byKey[key] === pass ? pass : `${byKey[key]}, ${pass}`;
    }
    const lines = Object.keys(byKey)
      .sort()
      .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(byKey[k])},`);
    writeFileSync(
      join(ROOT, "tools/opt-b-moved.ts"),
      `// Written by tools/opt-b-pins.ts --write: each -O1 and -O2 pin optimiser phase B moved (SPEC M5's phase B record, D73),
// by its key, with the first of phase B's passes, in the order they run, that moved it. Nothing at -O0 moves.
export const OPT_B_MOVED: Record<string, string> = {
${lines.join("\n")}
};

/** A -O1 or -O2 pin phase B moved, as listed. */
export const optBMoved = (k: string): boolean => /@O[12]$/.test(k) && Object.hasOwn(OPT_B_MOVED, k);
`,
    );
  }
}
