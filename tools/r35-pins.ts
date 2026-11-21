// Which pinned tirhashes R35 moves (SPEC M5's R35 record, 4.3, 4.4, 3.5, D44), and why. Every pin file is computed once per
// stage, each stage turning one more of R35's changes on (TMK_R35_OFF turns tslc's and the optimiser's parts off; R35
// changed no library's source):
//
//   none      everything of R35's off: must give every pin as pinned, or as an earlier round listed it
//   checks    -O1's check elimination in one round of range.ts, a loop header's parameters taken as anything (the
//             optimiser's, -O1 only: it moves -O1 pins alone, TSL proper's among them, as D44 allows)
//   units     class printing's one-unit string past the table made in line by `jsStrUnitNew` (a printer's change in `rc`)
//   joined    class printing's short joins copying each part at the runs' lengths before it (a printer's change in `rc`)
//
// The backend's saves around cold calls (`saves`) are machine code only: no pin is of machine code, so none moves by them.
// The tool fails if a pin moves at -O0 by anything but the stages that may (`units`, `joined`), and lists the TSL
// proper pins each stage moved.
//
// `node tools/r35-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r35-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** The stages that are printer or compiler changes, not the optimiser's: they may move -O0 pins (D44). */
const EVERY_LEVEL = ["units", "joined"];

export const R35_STAGES: {
  name: string;
  off: string;
  why: string;
}[] = [
  { name: "none", off: "checks,saves,units,joined", why: "" },
  {
    name: "checks",
    off: "units,joined",
    why: "the optimiser (R35): -O1's check elimination in one round of range.ts, a loop header's parameters taken as anything their type allows, so no going round and no widening; a check goes only where that proves it can't fire (4.3, D44); -O1 only",
  },
  {
    name: "units",
    off: "joined",
    why: "class printing in `rc` (R35): a one-unit string past the table made in line by `jsStrUnitNew`, its length known when it's compiled, where `jsStrUnitMade` made it out of line; a printer's change, at every level",
  },
  {
    name: "joined",
    off: "",
    why: "class printing in `rc` (R35): `jsStrJoined` and `jsStrJoined3` copying each part after the runs before it at their lengths, where they converted a length (checked); a printer's change, at every level",
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

function child(st: (typeof R35_STAGES)[number]): Promise<Record<string, Got>> {
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
    if (st.off !== "") env.TMK_R35_OFF = st.off;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r35-child"],
      { cwd: ROOT, env, maxBuffer: 512 << 20, timeout: 7_200_000 },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, Got>)),
    );
  });
}

async function main(): Promise<void> {
  const { mapsMoved } = await import("./maps-pins.ts");
  const t0 = Date.now();
  // the stages side by side, each its own child (one compile each, under its own 3 GiB heap limit)
  const stages: Record<string, Got>[] = await Promise.all(
    R35_STAGES.map((st) =>
      child(st).then((r) => {
        console.error(`stage ${st.name}: ${Math.round((Date.now() - t0) / 1000)} s`);
        return r;
      }),
    ),
  );
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
    for (let i = 1; i < R35_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R35_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No pin may move at -O0 but by the library's or the compiler's changes (D44), and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.tslProper === true &&
        (last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => EVERY_LEVEL.includes(x))) ||
      ((last[k]?.level ?? 0) === 0 &&
        !stageOf[k]!.split("+").every((x) => EVERY_LEVEL.includes(x))) ||
      /^(threw|diags):/.test(last[k]?.h ?? "") ||
      // -O1's one round is -O1's alone: it moves no pin at -O0 or -O2
      (stageOf[k]!.split("+").includes("checks") && (last[k]?.level ?? 0) !== 1),
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
  // A pin file left read-only (corpus/memory/pre-strings-tirhash.json, the state before strings) is never pinned again:
  // its moves are set aside by key, with why (R35_MOVED), as R10 to R34 set theirs.
  const frozen = (file: string): boolean => {
    try {
      accessSync(join(ROOT, file), constants.W_OK);
      return false;
    } catch {
      return true;
    }
  };
  if (process.argv.includes("--write") && unexplained.length === 0 && bad.length === 0) {
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
    const whys = R35_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r35-moved.ts"),
      `// Written by tools/r35-pins.ts --write: each pin R35 moved (SPEC M5's R35 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R35_MOVED, as R10 to R34 set theirs.

/** What each of R35's stages is, by the name tools/r35-pins.ts gives it. */
export const R35_WHY: Record<string, string> = {
${whys}
};

/** Each pin R35 moved and pinned again, with the stage that moved it. */
export const R35_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R35 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R35_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R35 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r35Moved = (k: string): boolean =>
  Object.keys(R35_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r35-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
