// The spec's `// file:` blocks are source, and they can't drift (SPEC 3.5, M3): corpus/spec holds each one byte
// for byte, and @tsl/alloc's three modules, @tsl/std's five, @tsl/gc's one and @tsl/jsrt's three are the same bytes. `--write` regenerates them from the spec.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

export function specBlocks(): Map<string, string> {
  const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
  const out = new Map<string, string>();
  for (const m of spec.matchAll(/```ts\n\/\/ file: (ex-[\w-]+\.ts)\n([\s\S]*?)```/g)) {
    out.set(m[1]!, `// file: ${m[1]!}\n${m[2]!}`);
  }
  return out;
}

export const ALLOC_MODULES = ["ex-heap.ts", "ex-vec.ts", "ex-slab.ts"];
export const STD_MODULES = [
  "ex-std-global.ts",
  "ex-std-vec.ts",
  "ex-std-slab.ts",
  "ex-std-map.ts",
  "ex-std-str.ts",
];

export const GC_MODULES = ["ex-gc-rc.ts", "ex-gc-roomarray.ts"];
export const JSRT_MODULES = ["ex-jsrt-array.ts", "ex-jsrt-map.ts", "ex-jsrt-string.ts"];

export function checkBlocks(write: boolean): string[] {
  const problems: string[] = [];
  const blocks = specBlocks();
  if (blocks.size < 10) problems.push(`only ${blocks.size} blocks found in SPEC.md`);
  for (const [name, text] of blocks) {
    const places = [join(ROOT, "corpus/spec", name)];
    if (ALLOC_MODULES.includes(name)) places.push(join(ROOT, "packages/tsl-alloc", name));
    if (STD_MODULES.includes(name)) places.push(join(ROOT, "packages/tsl-std", name));
    if (GC_MODULES.includes(name)) places.push(join(ROOT, "packages/tsl-gc", name));
    if (JSRT_MODULES.includes(name)) places.push(join(ROOT, "packages/tsl-jsrt", name));
    for (const path of places) {
      if (write) writeFileSync(path, text);
      else if (!existsSync(path)) problems.push(`${path} is missing`);
      else if (readFileSync(path, "utf8") !== text) problems.push(`${path} differs from SPEC.md`);
    }
  }
  return problems;
}

if (process.argv[1]?.endsWith("spec-extract.ts")) {
  const problems = checkBlocks(process.argv.includes("--write"));
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `ok: ${specBlocks().size} blocks` : "FAIL");
  process.exit(problems.length === 0 ? 0 : 1);
}
