// `@tsl/std` (SPEC 3.5, D43) costs nothing to a module that doesn't use it: prints the tirhash of every program in every
// memory mode and every `rc` build. corpus/memory/pre-std-tirhash.json pins these from before that work existed.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkFile, compileTyped, lowerFile } from "../compiler/host/tslc.ts";
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

const hashes: Record<string, string> = {};
for (const d of ["corpus/pos", "corpus/mem", "corpus/spec", "corpus/trap", "corpus/memory"]) {
  for (const f of programs(join(ROOT, d))) {
    const c = checkFile(f);
    hashes[relative(ROOT, f)] =
      c.typed === null
        ? `diags:${c.diags.map((x) => x.code).join()}`
        : compileTyped(c.typed).tirHash;
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
    hashes[`${name}@strict`] = lowerFile(f).tirHash;
    hashes[`${name}@leak`] = lowerFile(f, { memory: "leak" }).tirHash;
    hashes[`${name}@manual`] = lowerFile(f, { memory: "manual" }).tirHash;
    hashes[`${name}@rc`] = lowerFile(f, { memory: "rc" }).tirHash;
    hashes[`${name}@rc+check`] = lowerFile(f, {
      memory: "rc",
      rc: { check: true, account: true },
    }).tirHash;
    hashes[`${name}@rc+off`] = lowerFile(f, { memory: "rc", rc: { cycles: false } }).tirHash;
  }
}
for (const f of ["bench/memory/list_lowered.ts", "bench/memory/churn_lowered.ts"]) {
  hashes[`${f}@rc`] = lowerFile(join(ROOT, f), { memory: "rc" }).tirHash;
}
process.stdout.write(`${JSON.stringify(hashes, null, 1)}\n`);
