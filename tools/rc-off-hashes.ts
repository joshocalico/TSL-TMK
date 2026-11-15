// `rc` with the cycle collector off is what `rc` was before it (SPEC 3.5, D41): prints the tirhash of every program in the
// release build and the test builds. corpus/memory/rc-off-tirhash.json pins these from before the collector existed.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lowerFile } from "../compiler/host/tslc.ts";
import { ROOT } from "./corpus.ts";

// Pins are -O0's: the TIR as lowered, which no level may move (SPEC D44). Whatever level the caller runs at.
process.env.TMK_OPT = "0";
// So nothing here takes the level from the caller, which a gate job's level trace would note (SPEC 8.3, D51).
delete process.env.TMK_LEVEL_TRACE;

function programs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) programs(p, out);
    else if (n.endsWith(".ts") && existsSync(p.replace(/\.ts$/, ".cases.json"))) out.push(p);
  }
  return out;
}

const off = { cycles: false } as const;
const hashes: Record<string, string> = {};
for (const d of [
  "corpus/lower/pos",
  "corpus/lower/fallback",
  "corpus/lower/memory",
  "corpus/lower/rc",
  "corpus/lower/rc-only",
  "corpus/native",
]) {
  for (const f of programs(join(ROOT, d))) {
    const name = relative(ROOT, f);
    hashes[`${name}@rc`] = lowerFile(f, { memory: "rc", rc: off }).tirHash;
    hashes[`${name}@rc+check`] = lowerFile(f, {
      memory: "rc",
      rc: { ...off, check: true, account: true },
    }).tirHash;
  }
}
for (const f of ["bench/memory/list_lowered.ts", "bench/memory/churn_lowered.ts"]) {
  hashes[`${f}@rc`] = lowerFile(join(ROOT, f), { memory: "rc", rc: off }).tirHash;
}
process.stdout.write(`${JSON.stringify(hashes, null, 1)}\n`);
