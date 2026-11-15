// Which pinned tirhashes R1e moves, and why (SPEC M5's R1e record, D41). R1e changed the direct route's `rc` runtime
// (compiler/host/down-rt.ts: a scan gives up an object whose count reaches zero before it decides), so every pin of a
// lowered `rc` build with the collector linked holds the new runtime, at every level, -O0 included. Every `rc` pin in the
// pin files is computed again: `@rc` and `@rc+check` (the collector on, as built by default) and `@rc+off` (off, which R1e
// mustn't move). Run once against the runtime before R1e, every pin must come out as pinned, which shows the method
// reproduces the pins and nothing else moved them; then against R1e's, what moved is listed, and must be only collector-on
// builds.
//
// Found 2026-11-12: against the runtime before R1e every pin of maps-tirhash.json, the one compared exactly here (pipe-a box
// 7), comes out as pinned, and the other files' rc pins differ exactly where earlier steps' moved lists already say; against
// R1e's, 158 more move, all maps-tirhash.json's `@rc` pins (79 at -O0, 79 at -O2), and no `rc+off` or rc-off pin.
//
// `node tools/r1e-pins.ts [--write]`: prints what moved, as JSON; with --write, pins maps-tirhash.json's moved ones again.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

const FILES = [
  "corpus/memory/opt-tirhash.json",
  "corpus/memory/lang-a-tirhash.json",
  "corpus/memory/maps-tirhash.json",
  "corpus/memory/pre-std-tirhash.json",
  "corpus/memory/pre-strings-tirhash.json",
  "corpus/memory/rc-off-tirhash.json",
];

/** Every rc pin's tirhash as the tree computes it now. */
async function computeAll(): Promise<Record<string, string>> {
  const { lowerFile } = await import("../compiler/host/tslc.ts");
  const out: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const key of Object.keys(pin)) {
      const m = /^(.*?)@(rc|rc\+check|rc\+off)(?:@O([012]))?$/.exec(key);
      if (m === null) continue;
      const [, f, mode, lvl] = m as unknown as [string, string, string, string | undefined];
      const opt = lvl === undefined ? {} : { opt: Number(lvl) as 0 | 1 | 2 };
      // rc-off-tirhash.json's `@rc` pins are builds with the collector off (`--cycles off`), as its box makes them
      const off = mode === "rc+off" || file.includes("rc-off");
      const rc =
        mode === "rc+check"
          ? { check: true, account: true, ...(off ? { cycles: false } : {}) }
          : off
            ? { cycles: false }
            : undefined;
      const o = lowerFile(join(ROOT, f), {
        memory: "rc",
        ...(rc !== undefined ? { rc } : {}),
        ...opt,
      });
      out[`${file}#${key}`] = o.tirHash;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  delete process.env.TMK_OPT;
  const now = await computeAll();
  const moved: string[] = [];
  for (const [k, v] of Object.entries(now)) {
    const [file, key] = k.split("#") as [string, string];
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    if (pin[key] !== v) moved.push(k);
  }
  const offMoved = moved.filter((k) => k.includes("rc+off") || k.includes("rc-off-tirhash"));
  console.log(
    JSON.stringify(
      { total: Object.keys(now).length, moved: moved.length, offMoved, moved_: moved },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write")) {
    for (const file of ["corpus/memory/maps-tirhash.json"]) {
      const path = join(ROOT, file);
      const pin = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const v = now[`${file}#${k}`];
        if (v !== undefined) pin[k] = v;
      }
      writeFileSync(path, `${JSON.stringify(pin, null, 2)}\n`);
    }
  }
}
