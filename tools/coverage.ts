// `tmk coverage` (SPEC 9.3, D48): the fraction of functions that lower natively in `rc`, by root cause, over every local corpus
// of ordinary TS, and with `--real` over the pinned real projects in corpus/real/manifest.json, read from the cache that
// `tmk corpus-fetch` fills. `--compiler DIR` measures another tree's compiler, such as a copy from before a change.
//
// A function is a unit: a function declaration, a method, a constructor, an accessor, or a function bound to a module-level
// name. A closure inside one goes with it. Each source file is lowered as a root, and a unit's outcome is what that file's
// lowering says: lowered, fallback with its root cause (a callee's fallback counted as the callee's cause), or unreached
// from the file's exports. Real projects' imports of other packages don't resolve here: a fallback in a function that
// touches one is counted as `unresolved-import`, and the cause it would otherwise have been given is kept, to say how much
// that hides.
//
// The real projects are untrusted data: only parsed and lowered, with this repo's own compiler options. Nothing of theirs
// is run, installed or built.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { buildPath } from "./build-dir.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

export interface Coverage {
  name: string;
  files: number;
  filesDone: number;
  timedOut: boolean;
  lowered: number;
  fallback: number;
  unreached: number;
  causes: Record<string, number>;
  hidden: Record<string, number>; // what unresolved-import stands in for
  touchingUnresolved: number;
  crashes: number;
  tsErrors: number;
  ms: number;
}

interface Manifest {
  cache: string;
  exclude: string[];
  projects: {
    dir: string;
    url: string;
    commit: string;
    license: string;
    sources: string[];
    kind?: string;
  }[];
}

export function manifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "corpus/real/manifest.json"), "utf8")) as Manifest;
}

export function cacheDir(m: Manifest): string {
  return m.cache.replace(/^~/, homedir());
}

function listFiles(dir: string, exclude: RegExp[], base: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(base, p);
      if (exclude.some((re) => re.test(rel))) continue;
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(p);
      } else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The repo's local corpora of ordinary TS. */
export function localFiles(): string[] {
  const dirs = ["corpus/lower", "corpus/native", "bench/jpeg/vendor"];
  return dirs
    .flatMap((d) => listFiles(join(ROOT, d), [], ROOT, [".ts"]))
    .filter((f) => !f.endsWith(".d.ts"));
}

type Unit = ts.Node;

function units(sf: ts.SourceFile): Unit[] {
  const out: Unit[] = [];
  const walk = (n: ts.Node, inside: boolean): void => {
    let isUnit = false;
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isConstructorDeclaration(n) ||
        ts.isGetAccessor(n) ||
        ts.isSetAccessor(n)) &&
      n.body !== undefined &&
      !inside
    )
      isUnit = true;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !inside) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p))
        isUnit = true;
    }
    if (isUnit) out.push(n);
    ts.forEachChild(n, (c) => walk(c, inside || isUnit));
  };
  walk(sf, false);
  return out;
}

/** Whether a unit names an import that didn't resolve: its type is `any`, whatever the code says. */
function touchesUnresolved(u: Unit, checker: ts.TypeChecker): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n)) {
      const s = checker.getSymbolAtLocation(n);
      if (s !== undefined && (s.flags & ts.SymbolFlags.Alias) !== 0) {
        const t = checker.getAliasedSymbol(s);
        if (t.declarations === undefined || t.declarations.length === 0) hit = true;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(u);
  return hit;
}

function options(): ts.CompilerOptions {
  const path = join(ROOT, "tsconfig.base.json");
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  const conv = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions, ROOT, path).options;
  return {
    ...conv,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
  };
}

/** Lowers each file as a root with the given compiler, within a time budget, and sorts its units by outcome. */
export async function measure(
  name: string,
  files: string[],
  compiler: string,
  budgetMs: number,
): Promise<Coverage> {
  const started = performance.now();
  const down = (await import(
    pathToFileURL(join(compiler, "compiler/host/down.ts")).href
  )) as typeof import("../compiler/host/down.ts");
  const rtDir = join(compiler, "compiler/rt");
  const rt = readdirSync(rtDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(rtDir, f));
  // Methods, constructors and accessors of exported classes are reachable from an export, so each file with one gets a
  // probe: a module of its own, beside it and only in this program, with an exported function calling each of them.
  const probes = new Map<string, string>();
  for (const file of files) {
    try {
      const text = probeText(file);
      if (text !== null) probes.set(probePath(file), text);
    } catch {
      // A file this can't read is measured as it is.
    }
  }
  const host = ts.createCompilerHost(options());
  const baseGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, fresh) => {
    const t = probes.get(name);
    return t !== undefined
      ? ts.createSourceFile(name, t, lang, true, ts.ScriptKind.TS)
      : baseGet(name, lang, onError, fresh);
  };
  const baseExists = host.fileExists.bind(host);
  host.fileExists = (name) => probes.has(name) || baseExists(name);
  const baseRead = host.readFile.bind(host);
  host.readFile = (name) => probes.get(name) ?? baseRead(name);
  const program = ts.createProgram([...files, ...probes.keys(), ...rt], options(), host);
  const checker = program.getTypeChecker();
  const out: Coverage = {
    name,
    files: files.length,
    filesDone: 0,
    timedOut: false,
    lowered: 0,
    fallback: 0,
    unreached: 0,
    causes: {},
    hidden: {},
    touchingUnresolved: 0,
    crashes: 0,
    tsErrors: 0,
    ms: 0,
  };
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1;
  };
  for (const file of files) {
    if (performance.now() - started > budgetMs) {
      out.timedOut = true;
      break;
    }
    const sf = program.getSourceFile(file);
    if (sf === undefined) continue;
    out.filesDone++;
    try {
      out.tsErrors +=
        program.getSemanticDiagnostics(sf).length + program.getSyntacticDiagnostics(sf).length;
    } catch {
      out.tsErrors++; // the checker itself failed on this file
    }
    let us: Unit[];
    try {
      us = units(sf);
    } catch {
      continue;
    }
    if (us.length === 0) continue;
    type Result = import("../compiler/host/down.ts").DownResult;
    const lower = (f: ts.SourceFile): Result => {
      try {
        return new down.DownLower(program, f, "rc").run();
      } catch (e) {
        if (!(e instanceof down.RestartStrRt)) throw e;
        return new down.DownLower(program, f, "rc", {}, true).run();
      }
    };
    let r: Result | null = null;
    // What the file's probe reaches: its exported classes' members, through calls from outside, as a caller would make.
    let probe: Result | null = null;
    try {
      r = lower(sf);
      const psf = program.getSourceFile(probePath(file));
      if (psf !== undefined) {
        try {
          probe = lower(psf);
        } catch (e) {
          if (process.env.TMK_COVERAGE_DEBUG !== undefined)
            console.error(`probe of ${file}`, String(e).slice(0, 300));
        }
      }
    } catch (e) {
      out.crashes++;
      if (process.env.TMK_COVERAGE_DEBUG !== undefined)
        console.error(file, String(e).slice(0, 300));
      for (const u of us) {
        out.fallback++;
        bump(out.causes, "compiler-crash");
        void u;
      }
      continue;
    }
    const reached = new Set<ts.Node>();
    const byRoot = new Map<string, string>();
    for (const x of probe !== null ? [r, probe] : [r]) {
      for (const inst of x.insts) {
        reached.add(inst.owner);
        reached.add(inst.decl as ts.Node);
      }
      for (const [, f] of x.fallback)
        if (f.root === undefined) byRoot.set(`${f.line}:${f.file}`, f.blocker);
    }
    for (const u of us) {
      const unresolved = touchesUnresolved(u, checker);
      if (unresolved) out.touchingUnresolved++;
      const f = r.fallback.get(u) ?? probe?.fallback.get(u);
      if (f !== undefined) {
        out.fallback++;
        let cause = f.blocker;
        if (cause === "callee" && f.root !== undefined) cause = byRoot.get(f.root) ?? "callee";
        if (unresolved) {
          bump(out.hidden, cause);
          cause = "unresolved-import";
        }
        bump(out.causes, cause);
      } else if (reached.has(u)) out.lowered++;
      else out.unreached++;
    }
  }
  out.ms = Math.round(performance.now() - started);
  return out;
}

const probePath = (file: string): string => `${file.replace(/\.tsx?$/, "")}.__tmk_probe.ts`;

/**
 * A probe for a file's exported classes: an exported function for each public constructor, method and accessor, static or
 * not, that calls it with parameters of its own parameters' types. A generic class, a computed or private name, and a
 * protected or private member are left out: those are reached, if at all, from what calls them.
 */
function probeText(file: string): string | null {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const mods = (n: ts.Node): readonly ts.ModifierLike[] =>
    ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : [];
  const has = (n: ts.Node, k: ts.SyntaxKind): boolean => mods(n).some((m) => m.kind === k);
  const spec = `./${file.slice(file.lastIndexOf("/") + 1)}`;
  const lines: string[] = [];
  let n = 0;
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !has(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (st.typeParameters !== undefined) continue;
    const isDefault = has(st, ts.SyntaxKind.DefaultKeyword);
    const local = `__C${n}`;
    if (isDefault) lines.push(`import ${local} from ${JSON.stringify(spec)};`);
    else if (st.name !== undefined)
      lines.push(`import { ${st.name.text} as ${local} } from ${JSON.stringify(spec)};`);
    else continue;
    const hidden = (m: ts.Node): boolean =>
      has(m, ts.SyntaxKind.PrivateKeyword) || has(m, ts.SyntaxKind.ProtectedKeyword);
    const params = (
      ps: ts.NodeArray<ts.ParameterDeclaration>,
      of: string,
    ): { decl: string; pass: string } => {
      const rest = ps.some((p) => p.dotDotDotToken !== undefined);
      if (rest) return { decl: `...a: ${of}`, pass: "...a" };
      return {
        decl: ps.map((_, i) => `a${i}: ${of}[${i}]`).join(", "),
        pass: ps.map((_, i) => `a${i}`).join(", "),
      };
    };
    const fn = (what: string, decl: string, body: string): void => {
      lines.push(`export function __probe${n}_${lines.length}_${what}(${decl}) { ${body} }`);
    };
    const ctor = st.members.find(ts.isConstructorDeclaration);
    if (!has(st, ts.SyntaxKind.AbstractKeyword) && (ctor === undefined || !hidden(ctor))) {
      const p = params(
        ctor?.parameters ?? ts.factory.createNodeArray(),
        `ConstructorParameters<typeof ${local}>`,
      );
      fn("new", p.decl, `return new ${local}(${p.pass});`);
    }
    for (const m of st.members) {
      if (m.name === undefined || !ts.isIdentifier(m.name) || hidden(m)) continue;
      if (has(m, ts.SyntaxKind.AbstractKeyword)) continue;
      const name = m.name.text;
      const isStatic = has(m, ts.SyntaxKind.StaticKeyword);
      const self = isStatic ? local : "o";
      const selfT = isStatic ? `typeof ${local}` : local;
      const recv = isStatic ? "" : `o: ${local}`;
      const join = (a: string, b: string): string => [a, b].filter((x) => x !== "").join(", ");
      if (ts.isMethodDeclaration(m) && m.body !== undefined) {
        const p = params(m.parameters, `Parameters<${selfT}[${JSON.stringify(name)}]>`);
        fn(name, join(recv, p.decl), `return ${self}.${name}(${p.pass});`);
      } else if (ts.isGetAccessor(m) && m.body !== undefined) {
        fn(`get_${name}`, recv, `return ${self}.${name};`);
      } else if (ts.isSetAccessor(m) && m.body !== undefined) {
        fn(
          `set_${name}`,
          join(recv, `v: ${selfT}[${JSON.stringify(name)}]`),
          `${self}.${name} = v;`,
        );
      }
    }
    n++;
  }
  return lines.some((l) => l.startsWith("export ")) ? lines.join("\n") + "\n" : null;
}

export function percent(c: Coverage): string {
  const n = c.lowered + c.fallback;
  return n === 0 ? "-" : `${((100 * c.lowered) / n).toFixed(1)}%`;
}

export function table(rows: Coverage[]): string {
  const lines = [
    "corpus                           lowered fallback unreached  native  files            top root causes",
  ];
  for (const c of rows) {
    const top = Object.entries(c.causes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    lines.push(
      `${c.name.padEnd(32)} ${String(c.lowered).padStart(7)} ${String(c.fallback).padStart(8)} ${String(c.unreached).padStart(9)} ${percent(c).padStart(7)}  ${`${c.filesDone}/${c.files}${c.timedOut ? "+" : ""}`.padEnd(16)} ${top}`,
    );
  }
  return lines.join("\n");
}

export function total(name: string, rows: Coverage[]): Coverage {
  const t: Coverage = {
    name,
    files: 0,
    filesDone: 0,
    timedOut: false,
    lowered: 0,
    fallback: 0,
    unreached: 0,
    causes: {},
    hidden: {},
    touchingUnresolved: 0,
    crashes: 0,
    tsErrors: 0,
    ms: 0,
  };
  for (const r of rows) {
    t.files += r.files;
    t.filesDone += r.filesDone;
    t.timedOut ||= r.timedOut;
    t.lowered += r.lowered;
    t.fallback += r.fallback;
    t.unreached += r.unreached;
    t.touchingUnresolved += r.touchingUnresolved;
    t.crashes += r.crashes;
    t.tsErrors += r.tsErrors;
    t.ms += r.ms;
    for (const [k, v] of Object.entries(r.causes)) t.causes[k] = (t.causes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.hidden)) t.hidden[k] = (t.hidden[k] ?? 0) + v;
  }
  return t;
}

/** One real project's files, as the manifest says. */
export function projectFiles(m: Manifest, dir: string): string[] {
  const p = m.projects.find((x) => x.dir === dir);
  if (p === undefined) throw new Error(`no project ${dir} in the manifest`);
  const base = join(cacheDir(m), p.dir);
  // test262 is tests by nature, all of it: a sample of its files, as it's 54,000 of them and untyped (a later phase's).
  const exclude = p.kind === "js" ? [] : m.exclude.map((s) => new RegExp(s));
  const exts = p.kind === "js" ? [".js"] : [".ts", ".tsx"];
  const all = [...new Set(p.sources.flatMap((s) => listFiles(join(base, s), exclude, base, exts)))];
  return p.kind === "js" ? all.filter((_, i) => i % 50 === 0) : all;
}

// A child per project: one TS program of its sources, lowered file by file, printed as JSON.
if (process.argv[1]?.endsWith("coverage.ts") === true) {
  const argv = process.argv.slice(2);
  const val = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i < 0 ? d : argv[i + 1]!;
  };
  const compiler = realpathSync(resolve(val("--compiler", ROOT)));
  const budget = Number(val("--budget", "120000"));
  const project = val("--project", "");
  const m = manifest();
  // `local-before`: the local corpora as they were before language phase A, without what was written for it.
  const added = /corpus\/lower\/(exc|exc-fallback)\/|js_throw_through\.ts$/;
  const files =
    project === "local"
      ? localFiles()
      : project === "local-before"
        ? localFiles().filter((f) => !added.test(f))
        : projectFiles(m, project);
  const c = await measure(project, files, compiler, budget);
  mkdirSync(buildPath("coverage"), { recursive: true });
  writeFileSync(buildPath(`coverage/${project}.json`), JSON.stringify(c));
  process.stdout.write(JSON.stringify(c));
}
