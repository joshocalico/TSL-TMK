// The macos-arm64 target's host side (D57): builds a program's object with hosted.ts, links it with the system linker
// against libSystem (which also signs it ad hoc), and checks the signature. Used by `tmk compile|lower --target
// macos-arm64` and tools/macho-tests.ts. The linker, xcrun and codesign are dev-time tools; nothing else is linked in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildHostedObject, MACOS_MIN } from "../compiler/backend-aarch64/hosted.ts";
import type { ImageOutput } from "../compiler/backend-aarch64/image.ts";

export const TARGET = "macos-arm64";

let sdk: { path: string; version: [number, number, number] } | undefined;

/** The SDK's path and version: libSystem's stubs come from there. */
export function sdkInfo(): { path: string; version: [number, number, number] } {
  if (sdk !== undefined) return sdk;
  const r = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const path = r.status === 0 ? r.stdout.trim() : "";
  if (path === "" || !existsSync(path))
    throw new Error(`macos-arm64: no macOS SDK (xcrun said: ${r.stderr.trim()})`);
  let version: [number, number, number] = [...MACOS_MIN];
  try {
    const v = (JSON.parse(readFileSync(`${path}/SDKSettings.json`, "utf8")) as { Version?: string })
      .Version;
    const parts = (v ?? "").split(".").map(Number);
    if (parts.length > 0 && parts.every((n) => Number.isInteger(n)))
      version = [parts[0]!, parts[1] ?? 0, parts[2] ?? 0];
  } catch {
    // an SDK with no settings file links as well with the minimum as its version
  }
  sdk = { path, version };
  return sdk;
}

const dotted = (v: [number, number, number]): string => v.join(".");

/** Links an object into an executable with the system `ld`: libSystem only, `_main` the entry. */
export function linkObject(objPath: string, outPath: string): { ok: boolean; message: string } {
  const s = sdkInfo();
  const args = [
    "-arch",
    "arm64",
    "-platform_version",
    "macos",
    dotted(MACOS_MIN),
    dotted(s.version),
    "-syslibroot",
    s.path,
    "-lSystem",
    "-e",
    "_main",
    "-o",
    outPath,
    objPath,
  ];
  const r = spawnSync("ld", args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0)
    return { ok: false, message: `ld failed: ${r.stderr || r.error?.message || ""}`.trim() };
  // arm64 macOS runs only signed code; ld signs ad hoc, and this checks it did.
  const c = spawnSync("codesign", ["-v", outPath], { encoding: "utf8", timeout: 30_000 });
  if (c.status !== 0) return { ok: false, message: `codesign -v failed: ${c.stderr.trim()}` };
  return { ok: true, message: r.stderr.trim() };
}

/** Writes `image`'s object beside `outPath` (as `.o`) and links it there. */
export function writeExecutable(
  image: ImageOutput,
  outPath: string,
): { ok: boolean; message: string } {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const obj = `${outPath}.o`;
  writeFileSync(obj, image.bytes);
  return linkObject(obj, outPath);
}

export { buildHostedObject };

/** A program's cases: its `.cases.json`, or, with none, a call of an exported `main()` with no arguments. */
export function casesFor(
  file: string,
  exports: Record<string, { params: unknown[] }>,
): { fn: string; args: unknown[] }[] | string {
  const cf = file.replace(/\.ts$/, ".cases.json");
  if (existsSync(cf))
    return JSON.parse(readFileSync(cf, "utf8")) as { fn: string; args: unknown[] }[];
  const main = exports.main;
  if (main !== undefined && main.params.length === 0) return [{ fn: "main", args: [] }];
  return `${file}: no ${cf.replace(/.*\//, "")} and no exported main() to run`;
}

/** `// memory-pages: n|none` in a program's source: the page source's limit for a test image, as the corpus reads it. */
export function pagesOf(file: string, allowNone: boolean): number | undefined {
  const p = /^\/\/ memory-pages: (\d+|none)$/m.exec(readFileSync(file, "utf8"))?.[1];
  if (p === undefined) return undefined;
  if (p === "none") return allowNone ? -1 : undefined;
  return Number(p);
}

/** `// rc-stack: n` in a lowered program's source: its stack, as the corpus reads it. */
export function stackOf(file: string): number | undefined {
  const s = /^\/\/ rc-stack: (\d+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return s === undefined ? undefined : Number(s);
}

/**
 * `tmk compile <file> --target macos-arm64 [--out path]`: a TSL program as a native macOS executable that runs its cases
 * (its .cases.json, or `main()`) and prints what the QEMU image prints: TMK:READY, a TMK:C line per result, TMK:DONE.
 */
export async function compileForMacos(
  file: string,
  outFlag: string | undefined,
  defaultOut: string,
): Promise<number> {
  const { checkFile, compileTyped } = await import("../compiler/host/tslc.ts");
  const { formatDiag } = await import("../compiler/host/diag.ts");
  const { buildTslImage } = await import("./native-exec.ts");
  const abs = resolve(file);
  const { diags, typed } = checkFile(abs);
  if (typed === null) {
    console.error(diags.map(formatDiag).join("\n"));
    return 1;
  }
  const o = compileTyped(typed);
  const cases = casesFor(abs, o.meta.exports as never);
  if (typeof cases === "string") {
    console.error(cases);
    return 1;
  }
  const img = buildTslImage(
    o.tir,
    o.meta as never,
    cases as never,
    pagesOf(abs, true),
    0,
    buildHostedObject,
  );
  const out = outFlag ?? defaultOut;
  const l = writeExecutable(img, out);
  if (!l.ok) {
    console.error(l.message);
    return 1;
  }
  console.log(
    `${out}: Mach-O arm64 executable, ad-hoc signed, ${cases.length} cases\ntirhash ${o.tirHash}`,
  );
  return 0;
}

/**
 * `tmk lower <file> --target macos-arm64`: the lowered program linked as an executable at `base`, with its .cases.json's
 * cases when it has one and none falls back, or no cases (a module, its runtime and a page source), as `--target aarch64`.
 */
export async function linkLoweredForMacos(
  file: string,
  tir: import("../compiler/tir/ir.ts").Module,
  meta: unknown,
  base: string,
): Promise<{ ok: boolean; message: string; cases: number }> {
  const { buildDownImage } = await import("./native-exec.ts");
  const abs = resolve(file);
  const cf = abs.replace(/\.ts$/, ".cases.json");
  const exports = (meta as { exports: Record<string, { fallback?: boolean }> }).exports;
  let cases: { fn: string }[] = existsSync(cf)
    ? (JSON.parse(readFileSync(cf, "utf8")) as { fn: string }[])
    : [];
  if (cases.some((c) => exports[c.fn] === undefined || exports[c.fn]!.fallback === true))
    cases = [];
  const built = buildDownImage(
    tir,
    meta as never,
    cases as never,
    pagesOf(abs, false),
    { bulkBytes: 0 },
    undefined,
    stackOf(abs),
    buildHostedObject,
  );
  const l = writeExecutable(built.image, base);
  return { ...l, cases: cases.length };
}
