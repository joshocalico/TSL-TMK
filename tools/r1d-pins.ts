// Which pinned -O1 and -O2 tirhashes R1d moves, and why (SPEC M5's R1d record, D73). Every pin file with -O1 or -O2 entries
// is computed again twice: with the unreached pass off, and on. A pin that moves only with the pass on is put down to it (a
// function or global nothing reaches removed); one that differs with it off too was moved by R1d's @tsl/gc changes (release
// dispatch, pacing), which only programs using @tsl/gc can see. -O0 is untouched: the pass doesn't run there.
//
// `node tools/r1d-pins.ts [--write]`: prints what moved and why, as JSON; with --write, pins the moved ones again, in place.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./corpus.ts";

const FILES = [
  "corpus/memory/opt-tirhash.json",
  "corpus/memory/lang-a-tirhash.json",
  "corpus/memory/maps-tirhash.json",
  "corpus/memory/pipe-tirhash.json",
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

function child(off: boolean): Promise<Record<string, string>> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ["--no-warnings", import.meta.filename, "--child"],
      {
        cwd: ROOT,
        env: { ...process.env, TMK_OPT_DISABLE: off ? "unreached" : "", TMK_OPT: "" },
        maxBuffer: 256 << 20,
        timeout: 3_600_000,
      },
      (err, out) => (err !== null ? fail(err) : done(JSON.parse(out) as Record<string, string>)),
    );
  });
}

if (process.argv.includes("--child")) {
  process.stdout.write(JSON.stringify(await computeAll()));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const [off, on] = await Promise.all([child(true), child(false)]);
  const pinned: Record<string, string> = {};
  for (const file of FILES) {
    const pin = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(pin)) pinned[`${file}#${k}`] = v;
  }
  const byPass: string[] = [];
  const byGc: string[] = [];
  for (const k of Object.keys(on)) {
    if (on[k] === pinned[k]) continue;
    if (off[k] === pinned[k]) byPass.push(k);
    else byGc.push(k);
  }
  console.log(
    JSON.stringify(
      { total: Object.keys(on).length, byUnreachedPass: byPass, byGcChanges: byGc },
      null,
      1,
    ),
  );
  if (process.argv.includes("--write")) {
    for (const file of FILES) {
      const path = join(ROOT, file);
      const pin = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      for (const k of Object.keys(pin)) {
        const v = on[`${file}#${k}`];
        if (v !== undefined) pin[k] = v;
      }
      writeFileSync(path, `${JSON.stringify(pin, null, 1)}\n`);
    }
  }
}
