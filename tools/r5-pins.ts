// Which pinned tirhashes R5 moves (SPEC M5's R5 record, D36), and why. Found by computing every pinned tirhash (pre-std,
// strict, modes, rc off, pre-strings, opt at -O1 and -O2, maps and lang-a) with R5's tree, which must give every pin as
// pinned or as an earlier step listed it moved (tools/maps-pins.ts's mapsMoved), and again as if AUTO_BOUNDARY were on
// (TMK_EMIT_BOUNDARY=1), to say what switching it on would move.
//
// R5's changes reach nothing `auto` builds while AUTO_BOUNDARY is off: an exported function taking or giving an object
// prints with classes only where that's asked for, and the printing it takes is new code. Its one change to how a function
// prints, leaving out the lowering's dead return of nothing after a return (emit-tsl.ts's deadTail), applies only to an
// exported function whose result crosses the boundary, which is the same condition. Applied to every function, as first
// built, it moved 40 pins of 8 programs' leak, manual and rc builds (each losing a caller's null check), and made 21
// programs' printing rejected by tsc where a function returns a string literal's module state, which tsc reads as nullable;
// so it was narrowed, and moves none.
//
// `node tools/r5-pins.ts`: prints what moved, as JSON. Each stage runs in a process of its own.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

const DEAD_TAIL =
  "an exported function crossing the boundary printed with classes: in D36's listed layout, and without the lowering's dead return of nothing after a return, which made its result `| null` (R5, emit-tsl.ts's layBoundary and deadTail)";

/**
 * Each pinned tirhash R5 moves, by pin file and key, with why: none, by this tool's output on R5's tree (M5's R5 record).
 * `movedBySwitch` lists what switching AUTO_BOUNDARY on would move, for whoever does.
 */
export const R5_MOVED: Record<string, string> = {};

/** A pin R5 moved, by its key (`file@mode@O2` and the like), in any pin file. */
export const r5Moved = (k: string): boolean =>
  Object.keys(R5_MOVED).some((x) => x.endsWith(`#${k}`));

export const R5_WHY = DEAD_TAIL;

const TOOLS: { file: string; tool: string; args?: string[] }[] = [
  { file: "corpus/memory/pre-std-tirhash.json", tool: "tools/pre-std-hashes.ts" },
  { file: "corpus/memory/strict-tirhash.json", tool: "tools/strict-hashes.ts" },
  { file: "corpus/memory/modes-tirhash.json", tool: "tools/mode-hashes.ts" },
  { file: "corpus/memory/rc-off-tirhash.json", tool: "tools/rc-off-hashes.ts" },
  { file: "corpus/memory/pre-strings-tirhash.json", tool: "tools/pre-strings-hashes.ts" },
  {
    file: "corpus/memory/opt-tirhash.json",
    tool: "tools/opt-hashes.ts",
    args: ["--levels", "1,2"],
  },
];
const BY_KEY = ["corpus/memory/maps-tirhash.json", "corpus/memory/lang-a-tirhash.json"];

function run(args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ["--no-warnings", ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ...env, TMK_OPT: "" },
        maxBuffer: 256 << 20,
        timeout: 3_600_000,
      },
      (err, out) => (err !== null ? fail(err) : done(out)),
    );
  });
}

/** The maps and lang-a pins, `file@mode@O0` or `@O2`, as their boxes compute them. */
async function byKey(): Promise<Record<string, string>> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const out: Record<string, string> = {};
  for (const file of BY_KEY) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const k of Object.keys(pin)) {
      const [f, mem, o] = k.split("@");
      out[`${file}#${k}`] = lowerFile(join(ROOT, f!), {
        memory: mem!,
        opt: Number(o!.slice(1)) as 0 | 2,
      }).tirHash;
    }
  }
  return out;
}

async function stage(env: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const parts = await Promise.all([
    ...TOOLS.map(async (t) => {
      const got = JSON.parse(await run([join(ROOT, t.tool), ...(t.args ?? [])], env)) as Record<
        string,
        string
      >;
      return Object.fromEntries(Object.entries(got).map(([k, v]) => [`${t.file}#${k}`, v]));
    }),
    run([import.meta.filename, "--by-key"], env).then(
      (s) => JSON.parse(s) as Record<string, string>,
    ),
  ]);
  for (const p of parts) Object.assign(out, p);
  return out;
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  // R5's tree as it is, and as it would be with AUTO_BOUNDARY on (TMK_EMIT_BOUNDARY=1).
  const now = await stage({});
  const on = await stage({ TMK_EMIT_BOUNDARY: "1" });
  const pinned: Record<string, string> = {};
  for (const file of [...TOOLS.map((t) => t.file), ...BY_KEY]) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin)) pinned[`${file}#${k}`] = v;
  }
  // Every pin as pinned, or listed by the step that moved it (tools/maps-pins.ts's mapsMoved, R5_MOVED among them).
  const unexplained = Object.keys(pinned).filter(
    (k) => now[k] !== pinned[k] && !mapsMoved(k.split("#")[1]!),
  );
  const movedBySwitch = Object.keys(pinned).filter((k) => on[k] !== now[k]);
  console.log(
    JSON.stringify(
      { pins: Object.keys(pinned).length, unexplained, movedBySwitch, why: R5_WHY },
      null,
      1,
    ),
  );
}

// Not awaited at the top level: tools/maps-pins.ts imports this module, and a top-level await of it here never settles.
if (process.argv.includes("--by-key")) process.stdout.write(JSON.stringify(await byKey()));
else if (import.meta.main) void main();
