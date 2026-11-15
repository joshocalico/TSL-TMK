// The bare-metal images must not change when the macos-arm64 target is added: this builds the QEMU images of a set of
// corpus programs in-process (no QEMU, nothing run) and prints a SHA-256 for each, so two trees, or one tree before and
// after an edit, can be compared. `node tools/macho-bare-check.ts [--out file] [--compare file]`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
const { lowerFile } = await import("./lowering.ts");
const { buildTslImage, buildDownImage } = await import("./native-exec.ts");
const { parseModule, printModule } = await import("../compiler/tir/text.ts");

const list = (dir: string): string[] =>
  readdirSync(join(ROOT, dir))
    .filter(
      (f) => f.endsWith(".ts") && existsSync(join(ROOT, dir, f.replace(/\.ts$/, ".cases.json"))),
    )
    .sort()
    .map((f) => join(ROOT, dir, f));

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const out: Record<string, string> = {};

function tsl(file: string, level: string): void {
  process.env.TMK_OPT = level;
  const { typed } = checkFile(file);
  if (typed === null) {
    out[`${relative(ROOT, file)} -O${level}`] = "diags";
    return;
  }
  const o = compileTyped(typed);
  const m = parseModule(printModule(o.tir));
  if (o.tir.opt === 1 || o.tir.opt === 2) m.opt = o.tir.opt;
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"));
  const pages = /^\/\/ memory-pages: (\d+|none)$/m.exec(readFileSync(file, "utf8"))?.[1];
  const img = buildTslImage(
    m,
    o.meta as never,
    cases,
    pages === "none" ? -1 : pages !== undefined ? Number(pages) : undefined,
    0,
  );
  out[`${relative(ROOT, file)} -O${level}`] = sha(img.bytes);
}

function down(file: string, memory: string): void {
  delete process.env.TMK_OPT;
  const o = lowerFile(file, { memory, opt: 2 });
  if (o.diags.length > 0 || o.tir === null || o.tir === undefined) {
    out[`${relative(ROOT, file)} ${memory}`] = "diags";
    return;
  }
  const cases = JSON.parse(readFileSync(file.replace(/\.ts$/, ".cases.json"), "utf8"));
  try {
    const built = buildDownImage(o.tir, o.meta as never, cases);
    out[`${relative(ROOT, file)} ${memory}`] = sha(built.image.bytes);
  } catch (e) {
    out[`${relative(ROOT, file)} ${memory}`] = `error ${(e as Error).message.slice(0, 80)}`;
  }
}

for (const f of [...list("corpus/pos"), ...list("corpus/trap")]) {
  tsl(f, "0");
  tsl(f, "2");
}
for (const f of list("corpus/lower/pos").slice(0, 25)) {
  for (const mem of ["leak", "rc"]) down(f, mem);
}

const text = `${JSON.stringify(out, null, 1)}\n`;
const target = flag("--out");
if (target !== undefined) writeFileSync(target, text);
const cmp = flag("--compare");
if (cmp !== undefined) {
  const want = JSON.parse(readFileSync(cmp, "utf8")) as Record<string, string>;
  const keys = new Set([...Object.keys(want), ...Object.keys(out)]);
  let same = 0;
  const diff: string[] = [];
  for (const k of keys) {
    if (want[k] === out[k]) same++;
    else diff.push(k);
  }
  console.log(`${same} of ${keys.size} bare-metal images identical`);
  for (const k of diff) console.log(`  differs: ${k} (${want[k]} vs ${out[k]})`);
  process.exit(diff.length === 0 ? 0 : 1);
} else if (target === undefined) process.stdout.write(text);
else console.log(`${Object.keys(out).length} images hashed to ${target}`);
