// Which pinned tirhashes R16 moves (SPEC M5's R16 record, D44, D66), and why. Every pin file is computed once per stage,
// each stage turning one more of R16's changes on (TSL_TEST_PATCH puts @tsl/jsrt's two array classes back as they were, from
// SPEC.md.bak-pre-r16's `// file:` blocks):
//
//   none     the two classes as they were, and R16's printing off: must give every pin as pinned, or as an earlier step listed it
//   jsrt     @tsl/jsrt's JsArray and JsArenaArray as R16 has them: made at their final size in one step by an inlined
//            constructor, `push` inlined with its slow path out of line, `setLength` and `clear` inlined, growth leaner
//   pushlen  class printing: a push whose value nothing uses no longer prints the length read after it (TMK_R16_OFF)
//
// tslc's one change (a constructor takes `@tsl.inline` and `@tsl.noinline`, elab-native.ts) moves nothing by itself: no
// constructor had either tag before R16, so the `none` stage, which has it, shows it. A library change may move a lowered
// program's pins at every level, -O0 included (D44); a TSL proper pin mustn't move at -O0, and the tool fails if one does.
//
// `node tools/r16-pins.ts [--write]`: prints what moved, as JSON. With --write, and nothing unexplained or wrong, pins every
// moved one again in its file (a read-only one's set aside by key instead), and writes tools/r16-moved.ts, the record
// of each move with what moved it.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";
import { buildOf, FILES } from "./r6-pins.ts";

/** @tsl/jsrt's two array classes as they were before R16 (SPEC.md.bak-pre-r16's blocks), put back by TSL_TEST_PATCH. */
export function r16Undo(): string {
  const blocks = new Map<string, string>();
  const spec = readFileSync(join(ROOT, "SPEC.md.bak-pre-r16"), "utf8");
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g))
    blocks.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  const out: { file: string; from: string; to: string }[] = [];
  for (const f of ["ex-jsrt-array.ts", "ex-jsrt-arena.ts"]) {
    const now = readFileSync(join(ROOT, "packages/tsl-jsrt", f), "utf8");
    const was = blocks.get(f);
    if (was === undefined) throw new Error(`SPEC.md.bak-pre-r16 has no // file: ${f}`);
    if (now !== was) out.push({ file: `packages/tsl-jsrt/${f}`, from: now, to: was });
  }
  return JSON.stringify(out);
}

export const R16_STAGES: { name: string; undo: boolean; off: string; why: string }[] = [
  { name: "none", undo: true, off: "pushlen", why: "" },
  {
    name: "jsrt",
    undo: false,
    off: "pushlen",
    why: "@tsl/jsrt's JsArray and JsArenaArray (R16, D66): made at their final size in one step by an inlined constructor, push inlined with its slow path (pushGrow) out of line, setLength and clear inlined, growth leaner; a library change, which moves a lowered program's pins at every level (D44)",
  },
  {
    name: "pushlen",
    undo: false,
    off: "",
    why: "class printing (R16, emit-tsl.ts's pushedLength): a push whose value nothing uses no longer prints the lowering's read of the array's length after it",
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

function child(st: (typeof R16_STAGES)[number]): Promise<Record<string, Got>> {
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
    if (st.undo) env.TSL_TEST_PATCH = r16Undo();
    env.TMK_R16_OFF = st.off;
    execFile(
      process.execPath,
      ["--no-warnings", "--max-old-space-size=3072", import.meta.filename, "--r16-child"],
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
  for (const st of R16_STAGES) {
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
    for (let i = 1; i < R16_STAGES.length; i++)
      if (stages[i]![k]?.h !== stages[i - 1]![k]?.h) moved.push(R16_STAGES[i]!.name);
    if (moved.length > 0) stageOf[k] = moved.join("+");
  }
  const last = stages[stages.length - 1]!;
  // No TSL proper pin may move at -O0, and nothing may stop compiling.
  const bad = Object.keys(stageOf).filter(
    (k) =>
      (last[k]?.tslProper === true && (last[k]?.level ?? 0) === 0) ||
      /^(threw|diags):/.test(last[k]?.h ?? ""),
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
  // its moves are set aside by key, with why (R16_MOVED), as R10 to R12 set theirs.
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
    const whys = R16_STAGES.slice(1)
      .map((x) => `  ${x.name}:\n    ${JSON.stringify(x.why)},`)
      .join("\n");
    writeFileSync(
      join(ROOT, "tools/r16-moved.ts"),
      `// Written by tools/r16-pins.ts --write: each pin R16 moved (SPEC M5's R16 record), by pin file and key, with the stage
// that moved it. Each is pinned again in its file, so it's still compared exactly, but for those in a read-only pin file
// (pre-strings-tirhash.json, the state before strings), which are set aside by key in R16_MOVED, as R10 to R12 set theirs.

/** What each of R16's stages is, by the name tools/r16-pins.ts gives it. */
export const R16_WHY: Record<string, string> = {
${whys}
};

/** Each pin R16 moved and pinned again, with the stage that moved it. */
export const R16_REPINNED: Record<string, string> = {
${rows.join("\n")}
};

/** A pin R16 moved in a read-only pin file, set aside by key, with the stage that moved it. */
export const R16_MOVED: Record<string, string> = {
${aside.join("\n")}
};

/** A pin R16 moved and set aside, by its key (\`file@mode@O1\` and the like). */
export const r16Moved = (k: string): boolean =>
  Object.keys(R16_MOVED).some((x) => x.endsWith(\`#\${k}\`));
`,
    );
  }
}

// Not awaited at the top level, and by a flag of its own: nothing imports this for its side effects.
if (import.meta.main && process.argv.includes("--r16-child"))
  void computeAll().then((o) => process.stdout.write(JSON.stringify(o)));
else if (import.meta.main) void main();
