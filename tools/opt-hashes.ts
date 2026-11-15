// The optimiser's output, pinned (SPEC D44, D46): prints the tirhash of every program in the set pre-std-hashes.ts pins at
// -O0, plus @tsl/std's programs, at -O1 and -O2. corpus/memory/opt-tirhash.json pins these. A change to a pass that moves
// one is a change to what the compiler emits, and has to be re-pinned on purpose, with the corpus passing at that level.
// `node tools/opt-hashes.ts [--levels 1,2]`. Runs under Node or Bun, which must agree byte for byte.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkFile, compileTyped, lowerFile } from "../compiler/host/tslc.ts";
import type { OptLevel } from "../compiler/tir/passes/manager.ts";
import { ROOT } from "./corpus.ts";

function programs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) programs(p, out);
    else if (n.endsWith(".ts") && existsSync(p.replace(/\.ts$/, ".cases.json"))) out.push(p);
  }
  return out;
}

export function optHashes(levels: OptLevel[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const opt of levels) {
    const at = `@O${opt}`;
    for (const d of [
      "corpus/pos",
      "corpus/mem",
      "corpus/spec",
      "corpus/trap",
      "corpus/memory",
      "corpus/std",
    ]) {
      for (const f of programs(join(ROOT, d))) {
        const c = checkFile(f);
        hashes[`${relative(ROOT, f)}${at}`] =
          c.typed === null
            ? `diags:${c.diags.map((x) => x.code).join()}`
            : compileTyped(c.typed, { opt }).tirHash;
      }
    }
    for (const d of [
      "corpus/lower/pos",
      "corpus/lower/fallback",
      "corpus/lower/memory",
      "corpus/lower/rc",
      "corpus/lower/rc-only",
      "corpus/lower/strmap",
      "corpus/native",
    ]) {
      for (const f of programs(join(ROOT, d))) {
        const name = relative(ROOT, f);
        hashes[`${name}@strict${at}`] = lowerFile(f, { opt }).tirHash;
        hashes[`${name}@leak${at}`] = lowerFile(f, { memory: "leak", opt }).tirHash;
        hashes[`${name}@manual${at}`] = lowerFile(f, { memory: "manual", opt }).tirHash;
        hashes[`${name}@rc${at}`] = lowerFile(f, { memory: "rc", opt }).tirHash;
        hashes[`${name}@rc+check${at}`] = lowerFile(f, {
          memory: "rc",
          rc: { check: true, account: true },
          opt,
        }).tirHash;
        hashes[`${name}@rc+off${at}`] = lowerFile(f, {
          memory: "rc",
          rc: { cycles: false },
          opt,
        }).tirHash;
      }
    }
    for (const f of ["bench/memory/list_lowered.ts", "bench/memory/churn_lowered.ts"]) {
      hashes[`${f}@rc${at}`] = lowerFile(join(ROOT, f), { memory: "rc", opt }).tirHash;
    }
  }
  return hashes;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("opt-hashes.ts")) {
  const i = process.argv.indexOf("--levels");
  const levels = (i >= 0 ? process.argv[i + 1]! : "1,2")
    .split(",")
    .map((x) => Number(x) as OptLevel);
  process.stdout.write(`${JSON.stringify(optHashes(levels), null, 1)}\n`);
}
