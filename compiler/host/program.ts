// The TS checker adapter: builds a program with the spec's options and reports tsc's diagnostics.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Diag } from "./diag.ts";

export function repoRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let guard = 0; guard < 16; guard++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

export function repoRelative(file: string): string {
  return relative(repoRoot(), resolve(file));
}

let cachedOptions: ts.CompilerOptions | null = null;

function compilerOptions(): ts.CompilerOptions {
  if (cachedOptions !== null) return cachedOptions;
  const path = join(repoRoot(), "tsconfig.base.json");
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  const converted = ts.convertCompilerOptionsFromJson(
    parsed.config.compilerOptions,
    repoRoot(),
    path,
  );
  cachedOptions = { ...converted.options, types: [] };
  return cachedOptions;
}

// Library files never change during a run, so a batch of compiles shares their parsed forms.
const sourceCache = new Map<string, ts.SourceFile>();

/**
 * Reuse across compiles in one process (T2, D76), on unless TMK_COMPILE_REUSE=off, which takes exactly the paths before it:
 * the parsed and bound forms of the libraries' modules (packages/, compiler/rt, TypeScript's own lib files), keyed by their
 * text and the settings that shape a parse; module and lib resolution from those directories, which nothing changes during
 * a run (the gate hashes the tree before and after); a package's tsl.json read once per compile, not once per question;
 * and the printer's rounds of `!` sites checked by tsc alone (tslc.ts, compileViaTsl). None of it changes what a compile
 * gives, which tools/lowering.ts checks by compiling a sample of each run's compiles again with it off and comparing.
 */
let reuseForced: boolean | null = null;
export function compileReuse(): boolean {
  return reuseForced ?? process.env.TMK_COMPILE_REUSE !== "off";
}

/** Runs f with reuse on or off, whatever the environment says: the cold half of a check. */
export function withCompileReuse<X>(on: boolean, f: () => X): X {
  const was = reuseForced;
  reuseForced = on;
  try {
    return f();
  } finally {
    reuseForced = was;
  }
}

/** What a parse depends on besides the text: the program's options (by which of the two sets) and the file's own setting. */
function parseKey(outside: boolean, v: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
  const o = typeof v === "object" ? v : { languageVersion: v };
  return `${outside ? 1 : 0}:${o.languageVersion}:${o.impliedNodeFormat ?? ""}:${o.jsDocParsingMode ?? ""}`;
}

/** Files nothing changes during a run: the packages, the runtime lowered code reaches, and TypeScript's own. */
function libraryFile(name: string): boolean {
  const root = repoRoot();
  return (
    name.startsWith(join(root, "packages") + "/") ||
    name.startsWith(join(root, "compiler/rt") + "/") ||
    name.startsWith(join(root, "node_modules") + "/")
  );
}

const reusedSources = new Map<string, ts.SourceFile>();
const sharedResolution = new Map<string, ts.ModuleResolutionCache>();
const sharedLibResolution = new Map<
  string,
  Map<string, ts.ResolvedModuleWithFailedLookupLocations>
>();

/** A compile in progress: tsl.json files read once each, by directory, for its length (`inCompile`). */
let compileDepth = 0;
let tslJsonSeen: Map<string, TslPackage | null> | null = null;

/** Runs a compile: what it asks of the packages' tsl.json files is read once, and forgotten when it ends. */
export function inCompile<X>(f: () => X): X {
  if (compileDepth === 0 && compileReuse()) tslJsonSeen = new Map();
  compileDepth++;
  try {
    return f();
  } finally {
    compileDepth--;
    if (compileDepth === 0) tslJsonSeen = null;
  }
}

const RT_FILES = ["intrinsics", "str", "map", "array", "num", "case", "case-tables", "exc"];

/** The runtime lowered code reaches for strings, `Map` and `Set` (SPEC 4.5, D42): ordinary TS, part of the program only in a memory mode. */
export function rtFilePath(name: string): string {
  return join(repoRoot(), "compiler/rt", `${name}.ts`);
}

/**
 * A program over the files as written, except where `texts` gives a module's text instead: an `rc` package's modules as
 * expanded onto `@tsl/gc` (SPEC 3.5, D74).
 */
export function createTslProgram(
  file: string,
  withRuntime = false,
  texts?: Map<string, string>,
): ts.Program {
  // A file outside the repo has no package.json saying it's a module. tmk lower takes any strict TS
  // file (SPEC 4.5), and nodenext would call it CommonJS and reject its exports.
  const outside = repoRelative(file).startsWith("..");
  const options: ts.CompilerOptions = outside
    ? {
        ...compilerOptions(),
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      }
    : compilerOptions();
  const host = ts.createCompilerHost(options, true);
  const base = host.getSourceFile.bind(host);
  const reuse = compileReuse();
  if (reuse) shareResolution(host, options, outside);
  host.getSourceFile = (name, languageVersion, onError, fresh) => {
    // Tests of @tsl/std put a bug in it to show they catch it (`tmk milestone native-g`). It's the same text otherwise.
    // One patch, or a list (tools/r6-pins.ts puts R6's library changes back as they were, file by file).
    const patch = process.env.TSL_TEST_PATCH;
    const patches =
      patch === undefined
        ? []
        : ([JSON.parse(patch)].flat() as { file: string; from: string; to: string }[]).filter((p) =>
            name.endsWith(p.file),
          );
    if (patches.length > 0) {
      let text = readFileSync(name, "utf8");
      for (const p of patches) {
        if (!text.includes(p.from)) throw new Error(`TSL_TEST_PATCH: no ${p.from} in ${p.file}`);
        text = text.replace(p.from, p.to);
      }
      return ts.createSourceFile(name, text, languageVersion, true);
    }
    const expanded = texts?.get(name);
    if (expanded !== undefined) return ts.createSourceFile(name, expanded, languageVersion, true);
    if (reuse && libraryFile(name)) {
      // By its text as read now: the same text and settings give the same parse, and its binding with it.
      const text = host.readFile(name);
      if (text === undefined) return base(name, languageVersion, onError, fresh);
      const key = `${parseKey(outside, languageVersion)}:${name}`;
      const had = reusedSources.get(key);
      if (had !== undefined && had.text === text) return had;
      const sf = ts.createSourceFile(name, text, languageVersion, true);
      reusedSources.set(key, sf);
      return sf;
    }
    const shared =
      name.includes("/node_modules/") ||
      name.endsWith("packages/tsl-core/index.ts") ||
      name.endsWith("packages/tsl-unsafe/index.ts") ||
      name.includes("/compiler/rt/");
    if (!shared) return base(name, languageVersion, onError, fresh);
    let sf = sourceCache.get(name);
    if (sf === undefined) {
      sf = base(name, languageVersion, onError, fresh);
      if (sf !== undefined) sourceCache.set(name, sf);
    }
    return sf;
  };
  const roots = [resolve(file), ...(withRuntime ? RT_FILES.map(rtFilePath) : [])];
  return ts.createProgram(roots, options, host);
}

/**
 * Module resolution from a library file, and lib resolution, through caches the process keeps (T2): nothing they look at
 * changes during a run. From anywhere else (a program, a printed package), a cache of this program's own, as tsc makes.
 */
function shareResolution(
  host: ts.CompilerHost,
  options: ts.CompilerOptions,
  outside: boolean,
): void {
  const key = outside ? "outside" : "repo";
  const cwd = host.getCurrentDirectory();
  const canon = (f: string): string => host.getCanonicalFileName(f);
  let shared = sharedResolution.get(key);
  if (shared === undefined) {
    shared = ts.createModuleResolutionCache(cwd, canon, options);
    sharedResolution.set(key, shared);
  }
  const own = ts.createModuleResolutionCache(cwd, canon, options);
  const sharedCache = shared;
  host.getModuleResolutionCache = () => own;
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, opts, containingSf) => {
    const cache = libraryFile(containingFile) ? sharedCache : own;
    return literals.map((lit) =>
      ts.resolveModuleName(
        lit.text,
        containingFile,
        opts,
        host,
        cache,
        redirected,
        ts.getModeForUsageLocation(containingSf, lit, opts),
      ),
    );
  };
  // tsc's lib replacement looks for a `@typescript/lib-*` package above the working directory for each lib file, every
  // program: the same answer all run. Its hook isn't in tsc's published types (5.9), so it's taken only where it's there.
  const tsLib = (ts as unknown as { resolveLibrary?: LibResolver }).resolveLibrary;
  if (typeof tsLib !== "function") return;
  let libs = sharedLibResolution.get(key);
  if (libs === undefined) {
    libs = new Map();
    sharedLibResolution.set(key, libs);
  }
  const libCache = libs;
  const libResolution = ts.createModuleResolutionCache(cwd, canon, options);
  (host as ts.CompilerHost & { resolveLibrary?: LibResolver }).resolveLibrary = (
    name,
    from,
    opts,
  ) => {
    const k = `${name}\0${from}`;
    let r = libCache.get(k);
    if (r === undefined) {
      r = tsLib(name, from, opts, host, libResolution);
      libCache.set(k, r);
    }
    return r;
  };
}

type LibResolver = (
  name: string,
  from: string,
  opts: ts.CompilerOptions,
  host?: ts.ModuleResolutionHost,
  cache?: ts.ModuleResolutionCache,
) => ts.ResolvedModuleWithFailedLookupLocations;

/** tsc's own errors for one file: necessary, but not sufficient (SPEC 3.1). */
export function tscDiagnostics(program: ts.Program, sf: ts.SourceFile): Diag[] {
  const all = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sf),
    ...program.getSemanticDiagnostics(sf),
  ];
  const file = repoRelative(sf.fileName);
  const out: Diag[] = [];
  for (const d of all) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const pos = d.file !== undefined ? d.file.getLineAndCharacterOfPosition(d.start ?? 0) : null;
    out.push({
      code: `TS${d.code}`,
      file,
      line: pos !== null ? pos.line + 1 : 0,
      col: pos !== null ? pos.character + 1 : 0,
      msg: ts.flattenDiagnosticMessageText(d.messageText, " "),
    });
  }
  return out;
}

/** A module's unsafe permission (SPEC 3.8): its path, relative to its package, is listed in tsl.json. */
export function isUnsafeModule(file: string): boolean {
  const pkg = findTslJson(file);
  if (pkg === null) return false;
  const rel = relative(pkg.dir, resolve(file));
  return pkg.unsafeModules.includes(rel);
}

export interface TslPackage {
  dir: string;
  noFloat: boolean;
  unsafeModules: string[];
  noStd: boolean;
  noStdRaw: unknown;
  memory: unknown; // as written: configDiags says if it's no good
  jsonText: string;
  cycles?: unknown; // `rc`'s cycle collector (SPEC 3.5, 9.2, D41)
  lowered?: unknown; // a package `tmk lower --emit tsl` wrote (SPEC 4.5, D62): configDiags says if it's no good
}

export type MemorySetting = "strict" | "leak" | "manual";
export type LowerMemorySetting = MemorySetting | "rc";

/** A package's mode, for code that's lowered, where `rc` exists (SPEC 3.5). */
export function packageLowerMemory(file: string): LowerMemorySetting {
  const m = findTslJson(file)?.memory;
  return m === "rc" ? "rc" : packageMemory(file);
}

/** A package's memory mode (SPEC 3.5). A setting that's no good is reported by configDiags, and reads as strict. */
/**
 * The mode a class's objects have, for escape checking: a lowered package's own mode where it has one (phase 2's classes,
 * D62, D63), else the package's. Only escape checking asks this, so phase 1's printed packages are as they were elsewhere.
 */
/**
 * Which of TSL's speed-ups are switched off, for measuring each and for finding what moved a pin (D64): the classes' four,
 * `bytefill`, a byte array's `fill` as one memset (D66), and `clsid`, class ids' loads noted as invariant (D73).
 */
export function tslOptOff(
  name: "prefix" | "init" | "mask" | "ctorzero" | "bytefill" | "clsid",
): boolean {
  return (process.env.TMK_TSL_OPT_OFF ?? "").split(",").includes(name);
}

export function classMemory(file: string): MemorySetting {
  const pkg = findTslJson(file);
  const low = (pkg?.lowered as { memory?: unknown } | undefined)?.memory;
  if (low === "leak" || low === "manual") return low;
  return packageMemory(file);
}

export function packageMemory(file: string): MemorySetting {
  const m = findTslJson(file)?.memory;
  return m === "leak" || m === "manual" ? m : "strict";
}

function positionOf(text: string, key: string): { line: number; col: number } {
  const m = new RegExp(`"${key}"\\s*:\\s*`).exec(text);
  const at = m === null ? 0 : m.index + m[0].length;
  const before = text.slice(0, at).split("\n");
  return { line: before.length, col: before[before.length - 1]!.length + 1 };
}

/** What's wrong with a package's own settings, at the value in its tsl.json. */
export function configDiags(pkg: TslPackage): Diag[] {
  const out: Diag[] = [];
  const file = repoRelative(join(pkg.dir, "tsl.json"));
  if (pkg.memory !== undefined && pkg.memory !== "strict") {
    const pos = positionOf(pkg.jsonText, "memory");
    // `rc` is a desugaring onto @tsl/gc (D74): tslc expands the package's modules, and compiles what that gives
    if (pkg.memory !== "rc" && pkg.memory !== "leak" && pkg.memory !== "manual") {
      out.push({
        code: "TSL1019",
        file,
        ...pos,
        msg: `"memory" is "strict", "leak", "manual" or "rc", not ${JSON.stringify(pkg.memory)}`,
      });
    }
  }
  if (pkg.lowered !== undefined) {
    const why = loweredWhy(pkg.lowered);
    if (why !== null)
      out.push({ code: "TSL1019", file, ...positionOf(pkg.jsonText, "lowered"), msg: why });
    if (pkg.noStd === true || (pkg.memory !== undefined && pkg.memory !== "strict"))
      out.push({
        code: "TSL1023",
        file,
        ...positionOf(pkg.jsonText, "lowered"),
        msg: 'a "lowered" package says its memory mode in "lowered", and takes no other package setting',
      });
  }
  if (pkg.noStdRaw !== undefined && typeof pkg.noStdRaw !== "boolean") {
    out.push({
      code: "TSL1019",
      file,
      ...positionOf(pkg.jsonText, "noStd"),
      msg: '"noStd" is true or false',
    });
  }
  return out;
}

/** What's wrong with a "lowered" block, or null: the same rule elab-lowered.ts reads it by. */
function loweredWhy(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return '"lowered" is an object: { "memory": ... }';
  const o = raw as { memory?: unknown; runtime?: unknown };
  const m = o.memory ?? "strict";
  if (m !== "strict" && m !== "leak" && m !== "manual" && m !== "rc")
    return `"lowered.memory" is "strict", "leak", "manual" or "rc", not ${JSON.stringify(m)}`;
  const r = o.runtime ?? [];
  if (!Array.isArray(r) || r.some((x) => x !== "exc" && x !== "str" && x !== "hash"))
    return '"lowered.runtime" lists what the lowering linked beyond its base: "str", "hash", "exc"';
  return null;
}

/** The nearest tsl.json above a file, if any: membership marks a TSL module (SPEC 3.1). */
export function findTslJson(file: string): TslPackage | null {
  const seen = tslJsonSeen;
  if (seen === null) return findTslJsonFrom(dirname(resolve(file)));
  const start = dirname(resolve(file));
  let found = seen.get(start);
  if (found === undefined) {
    found = findTslJsonFrom(start);
    seen.set(start, found);
  }
  return found;
}

function findTslJsonFrom(start: string): TslPackage | null {
  let dir = start;
  for (let guard = 0; guard < 32; guard++) {
    const path = join(dir, "tsl.json");
    if (existsSync(path)) {
      const jsonText = readFileSync(path, "utf8");
      const json = JSON.parse(jsonText) as {
        noFloat?: boolean;
        unsafeModules?: string[];
        noStd?: unknown;
        memory?: unknown;
        cycles?: unknown;
        lowered?: unknown;
      };
      return {
        dir,
        noFloat: json.noFloat === true,
        unsafeModules: json.unsafeModules ?? [],
        noStd: json.noStd === true,
        noStdRaw: json.noStd,
        memory: json.memory,
        cycles: json.cycles,
        lowered: json.lowered,
        jsonText,
      };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
