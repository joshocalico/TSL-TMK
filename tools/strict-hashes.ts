// `strict` is today's behaviour, byte for byte (SPEC 3.5, D38): prints the tirhash of every program in the corpus,
// compiled with no memory mode anywhere. corpus/memory/strict-tirhash.json pins these from before the modes existed.
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
for (const d of ["corpus/pos", "corpus/mem", "corpus/spec", "corpus/trap"]) {
  for (const f of programs(join(ROOT, d))) {
    const c = checkFile(f);
    hashes[relative(ROOT, f)] =
      c.typed === null
        ? `diags:${c.diags.map((x) => x.code).join()}`
        : compileTyped(c.typed).tirHash;
  }
}
for (const d of ["corpus/lower/pos", "corpus/lower/fallback", "corpus/native"]) {
  for (const f of programs(join(ROOT, d))) hashes[relative(ROOT, f)] = lowerFile(f).tirHash;
}
process.stdout.write(`${JSON.stringify(hashes, null, 1)}\n`);
