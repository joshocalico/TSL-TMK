// Which pinned tirhashes R38 moves (SPEC M5's R38 record, 4.4, 4.5, D49, D62), and why. Every pin file is computed once per
// stage, each stage turning one more of R38's changes on (TMK_R38_OFF turns them off):
//
//   none      R38's switches off (rc's string runtime, `TRUSTED_RESHAPES_IN` and `TRUSTED_EXC_IN` rc as before, the
//             backend's coldness as R37's; the coldness is machine code only and moves no pin): must give every pin as
//             pinned, or as an earlier round listed it
//   units     rc's string runtime's one-unit answers (`compare`, `jsStrEq`), printed in every lowered rc program with strings
//             class printing prints, at every level
//   kinds     `TRUSTED_RESHAPES_IN` rc: `auto` takes in rc's class printing a program reshaped by a loop whose step or
//             condition has statements of its own, a route switch at every level
//   exc       `TRUSTED_EXC_IN` rc on: `auto` takes in rc's class printing a program with exceptions, a route switch at every
//             level
//
// TSL proper's pins can't move by either (they're lowering's route, and TSL proper isn't lowered), and the tool fails if one
// does.
//
// `node tools/r38-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r38-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** The stages that switch a route: they may move pins at every level, -O0's too (D44), but never TSL proper's. */
const EVERY_LEVEL = ["units", "kinds", "exc"];

export const R38_STAGES: {
  name: string;
  off: string;
  why: string;
}[] = [
  { name: "none", off: "units,kinds,exc,cold", why: "" },
  {
    name: "units",
    off: "kinds,exc,cold",
    why: "the printing (R38): rc's string runtime answers `compare` and `jsStrEq` of two strings of one unit each by their units in line, in every lowered rc program class printing gives strings to, at every level (the runtime is printed TSL), never TSL proper's",
  },
  {
    name: "kinds",
    off: "exc,cold",
    why: "the route (R38): `TRUSTED_RESHAPES_IN` rc, so `auto` takes in rc's class printing a program reshaped by a loop whose step or condition has statements of its own (and otherwise by kinds it trusts), every one no slower at -O1 and -O2; a route switch, at every level, never TSL proper's",
  },
  {
    name: "exc",
    off: "",
    why: "the route (R38): `TRUSTED_EXC_IN` rc on, so `auto` takes in rc's class printing a program with exceptions printed reshaped only by kinds it trusts there, every one no slower at -O1 and -O2; a route switch, at every level, never TSL proper's",
  },
];

interface Got {
  h: string;
  level?: number;
  mode?: string;
  tslProper?: boolean;
}

async function computeAll(): Promise<Record<string, Got>> {
  const { checkFile, compileTyped, lowerFile } = await import("../compiler/host/tslc.ts");
  const out: Record<string, Got> = {};
  // --from's child: only the pins a run before found moved (their ids, a JSON list in TMK_R38_ONLY's file)
  const onlyFile = process.env.TMK_R38_ONLY;
  const only =
    onlyFile !== undefined && onlyFile !== ""
      ? new Set(JSON.parse(readFileSync(onlyFile, "utf8")) as string[])
      : null;
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const id = `${file}#${key}`;
      if (only !== null && !only.has(id)) continue;
      const b = buildOf(file, key);
      const level = b.opts.opt as number;
      const mode = (b.opts.memory as string | undefined) ?? "strict";
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
          out[id] = { h: o.tirHash, level, mode, tslProper: true };
        } else {
          const r = lowerFile(b.path, b.opts as never);
          out[id] = { h: r.tirHash, level, mode, tslProper: false };
        }
      } catch (e) {
        out[id] = { h: `threw:${String(e).slice(0, 80)}`, level, mode };
      }
    }
  }
  return out;
}

function child(st: (typeof R38_STAGES)[number], onlyFile = ""): Promise<Record<string, Got>> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      TMK_OPT: "0",
      TMK_LEVEL_TRACE: "",
    };
    delete env.TMK_OPT_FAULT;
    delete env.TMK_OPT_DISABLE;
    delete env.TSL_TEST_PATCH;
    delete env.TMK_EMIT_STRS;
    delete env.TMK_EMIT_STRICT;
    delete env.TMK_EMIT_STRICT_ARRAYS;
    delete env.TMK_TRUST_RESHAPES;
    delete env.TMK_TRUST_IN;
    delete env.TMK_TEST_EMIT;
    delete env.TMK_TEST_TSL;
    delete env.TMK_R16_OFF;
    delete env.TMK_R17_OFF;
    delete env.TMK_R18_OFF;
    delete env.TMK_R19_OFF;
    delete env.TMK_R20_OFF;
    delete env.TMK_TSL_OPT_OFF;
    delete env.TMK_R21_OFF;
    delete env.TMK_R22_OFF;
    delete env.TMK_R23_OFF;
    delete env.TMK_R24_OFF;
    delete env.TMK_R25_OFF;
    delete env.TMK_R26_OFF;
    delete env.TMK_R27_OFF;
    delete env.TMK_R8_OFF;
    delete env.TMK_R28_OFF;
    delete env.TMK_R29_OFF;
    delete env.TMK_R30_OFF;
    delete env.TMK_R31_OFF;
    delete env.TMK_R32_OFF;
    delete env.TMK_R33_OFF;
    delete env.TMK_R34_OFF;
    delete env.TMK_R35_OFF;
    delete env.TMK_R36_OFF;
    delete env.TMK_R37_OFF;
    delete env.TMK_R38_OFF;
    if (st.off !== "") env.TMK_R38_OFF = st.off;
    delete env.TMK_R38_ONLY;
    if (onlyFile !== "") env.TMK_R38_ONLY = onlyFile;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r38-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

/**
 * `--write --from pins.json`: a run before this one (its JSON, with nothing unexplained or wrong) found what moved and by
 * which stage; only those pins are computed again, with every stage on, and pinned and recorded as a full run's --write
 * would (a full run computes all 3,864 pins four times over, an hour and a half).
 */
async function writeFrom(from: string): Promise<void> {
  const j = JSON.parse(readFileSync(from, "utf8")) as {
    unexplained: string[];
    bad: string[];
    movedKeys: Record<string, string>;
  };
  if (j.unexplained.length > 0 || j.bad.length > 0)
    throw new Error(`${from}: unexplained or wrong moves`);
  const ids = Object.keys(j.movedKeys);
  const list = join(ROOT, "build", "r38-pins-only.json");
  writeFileSync(list, JSON.stringify(ids));
  const last = await child(R38_STAGES[R38_STAGES.length - 1]!, list);
  const missing = ids.filter((k) => last[k] === undefined || /^(threw|diags):/.test(last[k]!.h));
  if (missing.length > 0) throw new Error(`not computed again: ${missing.slice(0, 5).join(", ")}`);
  writeMoves(j.movedKeys, last);
  console.log(JSON.stringify({ written: ids.length }));
}

async function main(): Promise<void> {
  const from = process.argv.includes("--from")
    ? process.argv[process.argv.indexOf("--from") + 1]
    : undefined;
  if (from !== undefined && process.argv.includes("--write")) return writeFrom(from);
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  // the stages one after another, each its own child (one compile each, under its own 3 GiB heap limit): R38 has four, and
  // four side by side pass the 3 GiB watchdog a run of this tool is under
  const stages: Record<string, Got>[] = [];
  for (const st of R38_STAGES) {
    stages.push(await child(st));
    console.error(`stage ${st.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
  }
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
    for (let i = 1; i < R38_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R38_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // A route switch moves lowered programs' pins at any level, never TSL proper's; and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      last[k]?.tslProper === true ||
      ((last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => EVERY_LEVEL.includes(x))) ||
      /^(threw|diags):/.test(last[k]?.h ?? ""),
  );
  const libraryProper = Object.keys(stageOf).filter(
    (k) => last[k]?.tslProper === true && (last[k]?.level ?? 0) === 0,
  );
  const programs = [...new Set(Object.keys(stageOf).map((k) => k.split("#")[1]!.split("@")[0]!))];
  const proper = Object.keys(stageOf).filter((k) => last[k]?.tslProper === true);
  const byLevel: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  for (const k of Object.keys(stageOf)) {
    byLevel[`O${last[k]?.level ?? "?"}`] = (byLevel[`O${last[k]?.level ?? "?"}`] ?? 0) + 1;
    byMode[last[k]?.mode ?? "?"] = (byMode[last[k]?.mode ?? "?"] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        pins: Object.keys(pinned).length,
        moved: Object.keys(stageOf).length,
        tslProperMoved: proper.length,
        tslProperKeys: Object.fromEntries(proper.map((k) => [k, stageOf[k]!])),
        tslProperO0ByLibrary: libraryProper,
        unexplained,
        bad,
        byLevel,
        byMode,
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
  if (process.argv.includes("--write") && unexplained.length === 0 && bad.length === 0)
    writeMoves(stageOf, last);
}

/** Pins each moved pin again (a read-only file's set aside by key) and writes tools/r38-moved.ts. */
function writeMoves(stageOf: Record<string, string>, last: Record<string, Got>): void {
  // A pin file left read-only (corpus/memory/pre-strings-tirhash.json, the state before strings) is never pinned again:
  // its moves are set aside by key, with why (R38_MOVED), as R10 to R37 set theirs.
  const frozen = (file: string): boolean => {
    try {
      accessSync(join(ROOT, file), constants.W_OK);
      return false;
    } catch {
      return true;
    }
  };
  {
    for (const file of FILES) {
      if (frozen(file)) continue;
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
    const aside: string[] = [];
    for (const [id, s] of Object.entries(stageOf).sort())
      (frozen(id.split("#")[0]!) ? aside : rows).push(
        `  ${JSON.stringify(id)}: ${JSON.stringify(s)},`,
      );
    const whys = R38_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r38-moved.ts"),
      `// Written by tools/r38-pins.ts --write: each pin R38 moved (SPEC M5's R38 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R38_MOVED, as R10 to R37 set theirs.

/** What each of R38's stages is, by the name tools/r38-pins.ts gives it. */
export const R38_WHY: Record<string, string> = {
${whys}
};

/** Each pin R38 moved and pinned again, with the stage that moved it. */
export const R38_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R38 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R38_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R38 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r38Moved = (k: string): boolean =>
  Object.keys(R38_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r38-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
