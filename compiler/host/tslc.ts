// tslc-host's front door: source file in, checked program out, and every artifact from there.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { emitWasm } from "../backend-wasm/emit.ts";
import { emitDownGlue } from "../backend-wasm/glue-down.ts";
import { emitGlue, type ModuleMeta } from "../backend-wasm/glue.ts";
import type { Module } from "../tir/ir.ts";
import { printModule, tirHash } from "../tir/text.ts";
import { verifyModule } from "../tir/verify.ts";
import {
  optFromEnv,
  optimizeModule,
  type OptLevel,
  type OptReport,
} from "../tir/passes/manager.ts";
import { DiagSink, type Diag } from "./diag.ts";
import type { RcOptions, RcStats } from "./down-rc.ts";
import { BLOCKERS, DownLower, RestartStrRt, type DownMeta, type DownResult } from "./down.ts";
import { Elaborator } from "./elab.ts";
import { emitJsChecked } from "./jschecked.ts";
import { lowerToTir } from "./lower.ts";
import { placeRegion } from "./region.ts";
import { markSeparatedFields } from "./separate.ts";
import { r13Off, r14Off, r6Off } from "./down-model.ts";
import {
  isArchFile,
  isCoreFile,
  isGlobalAllocatorCallee,
  isUnsafeFile,
  NativeElaborator,
  initSafe,
} from "./elab-native.ts";
import { checkEscapes } from "./escape.ts";
import { bangSites, EmitUnsupported, emitTsl, r12Off, type TslEmit } from "./emit-tsl.ts";
import { checkConsumes } from "./consume.ts";
import {
  expandRcProgram,
  isRcModule,
  loweredRcHeapClass,
  untaggedCounted,
  type RcExpansion,
} from "./expand-rc.ts";
import {
  isLoweredFile,
  LOWERED_TRAPS,
  loweredRuntime,
  parseLowered,
  type LoweredSetting,
} from "./elab-lowered.ts";
import { memoryRtFuncs, memoryRtGlobals, RT_TRAPS, stdRtFuncs } from "./down-rt.ts";
import {
  compileReuse,
  configDiags,
  createTslProgram,
  findTslJson,
  inCompile,
  isUnsafeModule,
  packageLowerMemory,
  packageMemory,
  repoRelative,
  repoRoot,
  tscDiagnostics,
  tslOptOff,
  type LowerMemorySetting,
} from "./program.ts";
import { checkSubset } from "./subset.ts";
import { describe, type RcStrLayout, type StrLayout, type TypedModule } from "./types.ts";
import { stmtBodies, walkTE } from "./walk.ts";

export interface CheckResult {
  diags: Diag[];
  typed: TypedModule | null;
}

/** The modules of a program that are ours: not libraries, and not the host's stand-ins for built-ins. */
function ownModules(program: ts.Program): ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter(
      (m) =>
        !m.isDeclarationFile &&
        !m.fileName.includes("/node_modules/") &&
        !isCoreFile(m.fileName) &&
        !isUnsafeFile(m.fileName) &&
        !isArchFile(m.fileName) &&
        !isLoweredFile(m.fileName),
    );
}

function diagAt(m: ts.SourceFile, node: ts.Node | null, code: string, msg: string): Diag {
  const pos = m.getLineAndCharacterOfPosition(node === null ? 0 : node.getStart(m));
  return {
    code,
    file: repoRelative(m.fileName),
    line: pos.line + 1,
    col: pos.character + 1,
    msg,
  };
}

/** A module's import, as tsc found it, whatever it was called in the source: an alias can't hide @tsl/std. */
function resolvedFile(
  program: ts.Program,
  m: ts.SourceFile,
  spec: ts.StringLiteral,
): string | null {
  const mod = program.getTypeChecker().getSymbolAtLocation(spec);
  const target = mod?.valueDeclaration;
  return target !== undefined && ts.isSourceFile(target) ? target.fileName : null;
}

const isStdSpecifier = (m: ts.SourceFile, spec: string, resolved: string | null): boolean =>
  spec === "@tsl/std" ||
  spec.startsWith("@tsl/std/") ||
  (spec.startsWith(".") && /(^|\/)tsl-std(\/|$)/.test(join(dirname(m.fileName), spec))) ||
  (resolved !== null && /\/packages\/tsl-std\//.test(resolved));

/**
 * Every module a noStd package imports, however far down and whoever's package it's in (D38). @tsl/std's own modules
 * aren't walked: its imports aren't the importer's concern, and the import that reaches it is the error.
 */
function noStdClosure(
  program: ts.Program,
  modules: ts.SourceFile[],
  pkgs: ReturnType<typeof findTslJson>[],
  rootNoStd: boolean,
): Set<ts.SourceFile> {
  const out = new Set<ts.SourceFile>();
  const visit = (m: ts.SourceFile): void => {
    if (out.has(m)) return;
    out.add(m);
    for (const st of m.statements) {
      if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
      const spec = st.moduleSpecifier;
      if (spec === undefined || !ts.isStringLiteral(spec)) continue;
      const file = resolvedFile(program, m, spec);
      if (file === null || /\/packages\/tsl-std\//.test(file)) continue;
      const next = program.getSourceFile(file);
      if (next !== undefined && modules.includes(next)) visit(next);
    }
  };
  modules.forEach((m, i) => {
    if (/\/packages\/tsl-std\//.test(m.fileName)) return;
    if (pkgs[i]?.noStd === true || (rootNoStd && pkgs[i] !== null)) visit(m);
  });
  return out;
}

/**
 * What a package's settings forbid, before tsc: @tsl/std doesn't exist yet, so tsc would only say it can't
 * find it, and a noStd package has to get the error that holds once it does exist (SPEC 9.2, D38).
 */
function packageDiags(program: ts.Program, root: string): Diag[] {
  const modules = ownModules(program);
  const out: Diag[] = [];
  const seen = new Set<string>();
  const pkgs = modules.map((m) => findTslJson(m.fileName));
  pkgs.forEach((pkg) => {
    if (pkg === null || seen.has(pkg.dir)) return;
    seen.add(pkg.dir);
    out.push(...configDiags(pkg));
  });
  const rootNoStd = findTslJson(root)?.noStd === true;
  const under = noStdClosure(program, modules, pkgs, rootNoStd);
  modules.forEach((m, i) => {
    const pkg = pkgs[i]!;
    if (under.has(m)) {
      for (const st of m.statements) {
        if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
        const spec = st.moduleSpecifier;
        if (spec === undefined || !ts.isStringLiteral(spec)) continue;
        if (isStdSpecifier(m, spec.text, resolvedFile(program, m, spec))) {
          out.push(
            diagAt(m, st, "TSL1018", `a package with "noStd": true can't import ${spec.text}`),
          );
        }
      }
    }
    // @tsl/lowered is a lowered package's alone (SPEC 4.5, D62): nothing a person writes is one, so nothing else reaches it.
    // R13: so is @tsl/jsrt's arena array, `strict` lowered code's: the kernel's own `strict` TSL can't depend on it.
    if (pkg === null || pkg.lowered === undefined) {
      for (const st of m.statements) {
        if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
        const spec = st.moduleSpecifier;
        if (spec === undefined || !ts.isStringLiteral(spec)) continue;
        const file = resolvedFile(program, m, spec);
        const target = file !== null ? findTslJson(file) : null;
        if (
          spec.text === "@tsl/lowered" ||
          spec.text === "@tsl/jsrt/arena" ||
          (file !== null && isLoweredFile(file)) ||
          (target !== null && target.lowered !== undefined)
        )
          out.push(
            diagAt(
              m,
              st,
              "TSL1023",
              `only a package tmk lower wrote, with "lowered" in its tsl.json, can import ${spec.text}`,
            ),
          );
      }
    }
    if (pkg === null) return;
    if (packageMemory(m.fileName) === "manual" && !isUnsafeModule(m.fileName)) {
      out.push(
        diagAt(
          m,
          null,
          "TSL5006",
          `every module in a "memory": "manual" package is unsafe code: list this one under "unsafeModules" in its tsl.json`,
        ),
      );
    }
  });
  return out;
}

/** Runs tsc's checker, then TSL's. tsc's errors come first, and TSL's rules assume they're absent. */
export function checkFile(file: string): CheckResult {
  return inCompile(() => checkFileUpTo(file, false));
}

/**
 * Every check before a module is elaborated, and what it found: the same diagnostics checkFile gives wherever it stops
 * before then, and none where it would go on (`typed` is always null). What the elaborator adds is TSL's own (TSLnnnn),
 * never tsc's, so the printer's rounds of `!` sites, which read tsc's alone, need no more (T2).
 */
export function checkFileBeforeElab(file: string): Diag[] {
  return inCompile(() => checkFileUpTo(file, true).diags);
}

function checkFileUpTo(file: string, beforeElab: boolean): CheckResult {
  let program = createTslProgram(file);
  let sf = program.getSourceFile(resolve(file));
  if (sf === undefined) throw new Error(`no source file for ${file}`);
  const early = packageDiags(program, resolve(file));
  if (early.length > 0) return { diags: early, typed: null };
  const tsc = tscDiagnostics(program, sf);
  if (tsc.length > 0) return { diags: tsc, typed: null };
  // An `rc` package's modules are expanded onto @tsl/gc (SPEC 3.5, D74), and what follows compiles the expansion.
  const rc = rcExpansion(program, file);
  if (rc !== null) {
    if (rc.diags.length > 0) return { diags: rc.diags, typed: null };
    program = createTslProgram(file, false, rc.texts);
    sf = program.getSourceFile(resolve(file))!;
  }
  const pkg = findTslJson(file);
  if (pkg !== null && usesNativeFeatures(sf)) return checkNative(program, sf, file, beforeElab);
  const sink = new DiagSink(repoRelative(file));
  if (pkg === null) {
    sink.add({
      code: "TSL9001",
      file: repoRelative(file),
      line: 1,
      col: 1,
      msg: "not in a package with a tsl.json; for ordinary TS, use tmk lower",
    });
    return { diags: sink.sorted(), typed: null };
  }
  checkSubset(program, sf, sink, pkg.noFloat);
  checkNoAllocRecursion(program, sf, sink);
  if (sink.list.length > 0 || beforeElab) return { diags: sink.sorted(), typed: null };
  const typed = new Elaborator(program, sf, sink).run();
  return { diags: sink.sorted(), typed: sink.list.length > 0 ? null : typed };
}

/**
 * The expansion of every `rc` module the program reaches (SPEC 3.5, D74), or null if it reaches none. tsc's own errors in
 * those modules come first, at their places in what was written.
 */
export function rcExpansion(program: ts.Program, file: string): RcExpansion | null {
  const rcMods = program
    .getSourceFiles()
    .filter(
      (m) =>
        !m.isDeclarationFile && !m.fileName.includes("/node_modules/") && isRcModule(m.fileName),
    );
  if (rcMods.length === 0) return null;
  for (const m of rcMods) {
    const d = tscDiagnostics(program, m);
    if (d.length > 0) return { texts: new Map(), diags: d };
  }
  // what TSL proper rejects is reported where it was written, before anything is expanded
  const sink = new DiagSink(repoRelative(file));
  for (const m of rcMods) {
    const pkg = findTslJson(m.fileName);
    checkSubset(program, m, sink, pkg?.noFloat === true, {
      native: true,
      unsafeAllowed: false,
      rc: true,
    });
  }
  if (sink.list.length > 0) return { texts: new Map(), diags: sink.sorted() };
  return expandRcProgram(program, resolve(file));
}

/** Classes, closures or other modules: anything else keeps M1's exact path, and its exact TIR. */
function usesNativeFeatures(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) {
      const m = st.moduleSpecifier;
      if (m !== undefined && ts.isStringLiteral(m) && m.text !== "@tsl/core") return true;
    }
    // A dispatch interface (D70) is a class-level feature: only the native elaborator knows it.
    if (
      ts.isInterfaceDeclaration(st) &&
      st.members.length > 0 &&
      st.members.every(ts.isMethodSignature)
    )
      return true;
    if (ts.isClassDeclaration(st) && st.heritageClauses === undefined) {
      const abstract = ts.getModifiers(st)?.some((x) => x.kind === ts.SyntaxKind.AbstractKeyword);
      if (abstract !== true) return true;
    }
  }
  let found = false;
  const walk = (n: ts.Node, nested: boolean): void => {
    if (found) return;
    if (nested && (ts.isArrowFunction(n) || ts.isFunctionDeclaration(n))) {
      found = true;
      return;
    }
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Using
    ) {
      found = true;
      return;
    }
    const inFn = nested || (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n));
    ts.forEachChild(n, (c) => {
      walk(c, inFn);
    });
  };
  walk(sf, false);
  return found;
}

/** Every TSL module a program imports, dependencies first. A value import cycle is TSL1010 (SPEC 3.6). */
function modulesOf(program: ts.Program, root: ts.SourceFile, sink: DiagSink): ts.SourceFile[] {
  const checker = program.getTypeChecker();
  const out: ts.SourceFile[] = [];
  const state = new Map<ts.SourceFile, 1 | 2>();
  const visit = (sf: ts.SourceFile): void => {
    state.set(sf, 1);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
      const spec = st.moduleSpecifier;
      if (spec === undefined || !ts.isStringLiteral(spec)) continue;
      const mod = checker.getSymbolAtLocation(spec);
      const target = mod?.valueDeclaration;
      if (target === undefined || !ts.isSourceFile(target)) continue;
      const name = target.fileName;
      if (isCoreFile(name) || isUnsafeFile(name) || isArchFile(name) || isLoweredFile(name))
        continue;
      const typeOnly =
        ts.isImportDeclaration(st) && st.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      const seen = state.get(target);
      if (seen === 1 && !typeOnly) sink.at(sf, st, "TSL1010", "module cycles are banned");
      if (seen === undefined) visit(target);
    }
    state.set(sf, 2);
    out.push(sf);
  };
  visit(root);
  return out;
}

function checkNative(
  program: ts.Program,
  root: ts.SourceFile,
  file: string,
  beforeElab = false,
): CheckResult {
  const sink = new DiagSink(repoRelative(file));
  const modules = modulesOf(program, root, sink);
  for (const m of modules) {
    const tsc = tscDiagnostics(program, m);
    if (tsc.length > 0) return { diags: tsc, typed: null };
  }
  for (const m of modules) {
    const pkg = findTslJson(m.fileName);
    if (pkg === null) {
      sink.add({
        code: "TSL9001",
        file: repoRelative(m.fileName),
        line: 1,
        col: 1,
        msg: "imported, but not in a package with a tsl.json",
      });
      continue;
    }
    checkSubset(program, m, sink, pkg.noFloat, {
      native: true,
      unsafeAllowed: isUnsafeModule(m.fileName),
    });
  }
  checkGlobalAllocators(program, modules, sink);
  checkConsumes(program, modules, sink);
  if (sink.list.length > 0 || beforeElab) return { diags: sink.sorted(), typed: null };
  const elab = new NativeElaborator(program, root, sink, modules);
  const lowered = parseLowered(findTslJson(file)?.lowered);
  const rt = lowered !== null && typeof lowered !== "string" ? loweredRuntime(lowered) : null;
  if (lowered !== null && typeof lowered !== "string") {
    elab.lowered = lowered;
    for (const f of rt!.funcs) elab.loweredSigs.set(f.name, f);
  }
  const typed = elab.run();
  if (sink.list.length > 0) return { diags: sink.sorted(), typed: null };
  const strLayout = elab.strLayout();
  if (strLayout !== null) typed.strLayout = strLayout;
  const rcStrLayout = elab.rcStrLayout();
  if (rcStrLayout !== null) typed.rcStrLayout = rcStrLayout;
  if (rt !== null) {
    // A lowered package links the runtime the lowering linked, and its module state (SPEC 4.5, D62); and @tsl/std's page
    // supply where the printing used @tsl/std, as JsArray's buffers do (D66).
    let std = false;
    for (const f of typed.funcs)
      walkTE(
        f.body,
        (te) => {
          if (te.k === "builtin" && te.name === "unsafe.sourcePages") std = true;
        },
        true,
      );
    typed.extraFuncs = std ? [...rt.funcs, ...stdRtFuncs()] : rt.funcs;
    typed.extraGlobals = [
      ...rt.globals,
      ...[...elab.loweredData.values()].map(
        (d) =>
          d.global ?? {
            name: d.name,
            size: Math.max(8, d.size),
            align: 8,
            section: "data" as const,
          },
      ),
    ];
    typed.extraTraps = LOWERED_TRAPS;
    typed.nativeOnly = true;
    // TSL's own classes in a lowered package (phase 2): an escaping `new` is the mode's, decided by escape analysis, as in
    // any package with that mode (SPEC 3.5, D63). A package with no TSL class has no `new`, and is what it was, byte for byte.
    const mode = (lowered as LoweredSetting).memory;
    if (hasNew(typed) && (mode === "leak" || mode === "manual")) {
      for (const f of typed.funcs) f.memory = mode;
      checkEscapes(typed, sink, mode);
      if (sink.list.length > 0) return { diags: sink.sorted(), typed: null };
      // R6: what no export call outlives, in the per-call region (D62's third ruling): tslc's own escape analysis.
      typed.region = placeRegion(typed);
      markPlainClasses(typed);
      dropZeroCtorInits(typed);
      markInvariantFields(typed);
      markSeparatedFields(typed);
    } else if (hasNew(typed) && mode === "strict" && !r12Off("strict")) {
      // R12: class printing in `strict`. What escapes its function goes where the direct route puts it, in the call arena
      // the module already has (`__alloc`), which the caller resets (D36): tslc's escape analysis puts it on the heap as
      // `leak`'s does, then every such `new` in the per-call region, which here an export doesn't give back at its return,
      // as the direct route's call arena isn't. A `strict` package has no heap, so a `new` that can outlive the export call
      // is refused, and the program prints as phase 1 did. Only a lowered package's; TSL proper's `strict` is as it was.
      for (const f of typed.funcs) f.memory = "leak";
      checkEscapes(typed, sink, "leak");
      if (sink.list.length > 0) return { diags: sink.sorted(), typed: null };
      typed.region = placeRegion(typed, false);
      // the injected `strict-stack-escape` bug (R12): what escapes its function left on its stack, not in the call arena
      if (process.env.TMK_TEST_TSL === "strict-stack-escape")
        for (const f of typed.funcs)
          walkTE(
            f.body,
            (te) => {
              if (te.k === "new" && te.heap === "region") te.heap = undefined;
            },
            true,
          );
      for (const f of typed.funcs)
        walkTE(
          f.body,
          (te) => {
            if (te.k !== "new" || te.heap === undefined || te.heap === "region") return;
            const m = /^(.*):(\d+):(\d+)$/.exec(te.at ?? "");
            sink.add({
              code: "TSL3001",
              file: m?.[1] ?? repoRelative(file),
              line: Number(m?.[2] ?? 1),
              col: Number(m?.[3] ?? 1),
              msg: `${te.c.name} can outlive the export call, and a strict package has no heap (R12): ${typed.region!.why.get(te.c.key) ?? "aligned past 8, or with a tail"}`,
            });
          },
          true,
        );
      if (sink.list.length > 0) return { diags: sink.sorted(), typed: null };
      markPlainClasses(typed);
      dropZeroCtorInits(typed);
      markInvariantFields(typed);
      markSeparatedFields(typed);
    } else if (hasNew(typed) && mode === "rc") {
      // `rc` (R2): the expansion made the package strict TSL counting with @tsl/gc (D74), checked as any strict package
      // is, and a library's functions, @tsl/jsrt's, keep their own package's mode.
      markFuncModes(typed);
      checkEscapes(typed, sink);
      if (sink.list.length > 0) return { diags: sink.sorted(), typed: null };
      markPlainClasses(typed);
      dropZeroCtorInits(typed);
      markInvariantFields(typed);
      markSeparatedFields(typed);
    }
    return { diags: sink.sorted(), typed };
  }
  markMemoryModes(typed, modules);
  checkEscapes(typed, sink);
  if (sink.list.length === 0) {
    markPlainClasses(typed);
    dropZeroCtorInits(typed);
    markInvariantFields(typed);
    markSeparatedFields(typed);
  }
  return { diags: sink.sorted(), typed: sink.list.length > 0 ? null : typed };
}

/**
 * Classes nothing of which can go stale, as a whole-program fact (SPEC 3.5, D38, D64), marked `plain`: none placed in a slot
 * (placeObject, objectAt: a Slab's), none static, none from an arena, none ever generation-checked, and not a layout class.
 * The prefix stays on every other class: whatever a Slab can hold, or a static has, or something checks, needs one.
 */
export function markPlainClasses(typed: TypedModule): void {
  if (tslOptOff("prefix")) return;
  const seen = new Map<string, import("./types.ts").ClassInst[]>();
  const not = new Set<string>();
  const note = (c: import("./types.ts").ClassInst): void => {
    seen.set(c.key, [...(seen.get(c.key) ?? []), c]);
  };
  const clsOf = (t: import("./types.ts").Ty): import("./types.ts").ClassInst | null =>
    t.k === "cls" ? t.c : null;
  for (const g of typed.globals) if (g.object !== undefined) not.add(g.object.c.key);
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        const c = clsOf(te.ty);
        if (c !== null) note(c);
        if (te.k === "new") note(te.c);
        if (te.k === "builtin") {
          if (
            te.name === "unsafe.place" ||
            te.name === "unsafe.placeTail" ||
            te.name === "unsafe.objectAt" ||
            te.name.startsWith("arena.")
          ) {
            if (c !== null) not.add(c.key);
            const ic = te.info?.c;
            if (ic !== undefined) not.add(ic.key);
          }
        }
        if ((te.k === "ofield" || te.k === "osetfield") && te.check !== false) not.add(te.c.key);
        if (te.k === "chkref" && te.check !== false) {
          const vc = clsOf(te.val.ty);
          if (vc !== null) not.add(vc.key);
        }
      },
      true,
    );
  // A dispatch interface's reference is one of its classes' (D70), so it and they are all plain or none is: the class-id
  // load through it reads the object as its class's own accesses do.
  for (let changed = true; changed;) {
    changed = false;
    for (const list of seen.values())
      for (const c of list) {
        const group = c.iface === undefined ? [] : [c, ...c.iface.set];
        if (
          group.some((x) => not.has(x.key) || x.align > 8) &&
          !group.every((x) => not.has(x.key))
        ) {
          for (const x of group) not.add(x.key);
          changed = true;
        }
      }
  }
  for (const [key, list] of seen)
    if (!not.has(key)) for (const c of list) if (!c.layout && c.align <= 8) c.plain = true;
}

/**
 * Fields nothing writes after construction, as a whole-program fact (SPEC 3.4's "Class ids don't change", D73), whose loads
 * are noted invariant (`ofield.inv`), for the optimiser to share at -O1 and -O2 across what can't change them:
 * - a dispatch interface's class id (D70), the hidden first field, which only `new` writes, before the reference exists;
 * - an integer field of a class with no constructor that's stored only as the next step after a `new` of its class into a
 *   variable, `(t = new C(), t.cid = 3, ...)`, with a literal: a printed class's id (D64), and anything written the same way.
 * Of a class, or each class of a dispatch interface, that's plain (nothing of it can go stale: no Slab, Rc store, static or
 * arena has one), never built in place inside another object, and never given to `unsafeFree`: so no object of it is ever
 * where another was, and none is ever where one will be while it can be read. What's left that could write one is unsafe
 * code writing a live object's class id, which @tsl/unsafe's rules forbid (3.8).
 *
 * R19 (3.4, D73): and a field of a class declared in a lowered `rc` package whose objects are all counted slots
 * (`loweredRcHeapClass`: counted exactly by tslc's expansion, not `@tsl.stack`), stored only by its class's own constructor
 * on `this`, with no closure in that constructor: an environment's kind and captures (R3), say. Such an object is made only
 * by a store's `make`, its constructor run on the object `make` copies into the slot, so every store to the field is before
 * a reference to the object exists; @tsl/gc reuses the slot only once no reference to it is left, counted or borrowed (3.5's
 * proof, which already stands behind no check on such a reference); and nothing else writes the package's objects' fields,
 * as a lowered package can't import @tsl/unsafe (TSL1023). A frame slot a constructor call could write again, which a
 * class kept on the stack would have, is why the class must have no stack objects.
 */
export function markInvariantFields(typed: TypedModule): void {
  if (tslOptOff("clsid")) return;
  type TEx = import("./types.ts").TE;
  type Stmt = import("./types.ts").Stmt;
  type ClassInst = import("./types.ts").ClassInst;
  const notOk = new Set<string>(); // classes not plain, built in place, or freed
  const withCtor = new Set<string>(); // classes some `new` of which runs a constructor
  const written = new Set<string>(); // `class|field` stored other than right after its `new`
  const atNew = new Set<string>(); // `class|field` stored right after its `new`
  const construction = new Set<TEx>();
  // The bug put into this rule (manager.ts OPT_FAULTS, `tmk milestone opt-a` box 12): a store after construction isn't seen.
  const ignoreStores = (process.env.TMK_OPT_FAULT ?? "")
    .split(",")
    .some((x) => x.trim() === "clsid-ignore-store");
  const isLit = (e: TEx): boolean => e.k === "lit" || (e.k === "conv" && isLit(e.val));
  const newInto = (e: TEx | null): { v: unknown; c: ClassInst } | null => {
    if (e === null) return null;
    if (e.k === "setvar" && e.val.k === "new" && e.val.into === null) return { v: e.v, c: e.val.c };
    return null;
  };
  const pair = (prev: { v: unknown; c: ClassInst } | null, cur: TEx): void => {
    if (prev === null || cur.k !== "osetfield") return;
    if (cur.obj.k !== "var" || cur.obj.v !== prev.v || cur.c.key !== prev.c.key) return;
    if (!isLit(cur.val) || cur.f.store !== "value" || cur.f.ty.k !== "int") return;
    construction.add(cur);
  };
  const scanStmts = (list: Stmt[]): void => {
    let prev: { v: unknown; c: ClassInst } | null = null;
    for (const st of list) {
      const e = st.k === "expr" ? st.e : null;
      if (e !== null) pair(prev, e);
      prev =
        st.k === "let" && st.init !== null && st.init.k === "new" && st.init.into === null
          ? { v: st.v, c: st.init.c }
          : newInto(e);
    }
  };
  for (const f of typed.funcs) {
    walkStmtsAll(f.body, scanStmts);
    walkTE(
      f.body,
      (te) => {
        if (te.k === "seq") {
          // `(t = new C(), t.cid = 3)`: the store is the next item, or the sequence's result.
          let prev: { v: unknown; c: ClassInst } | null = null;
          for (const it of [...te.items, te.result]) {
            pair(prev, it);
            prev = newInto(it);
          }
        } else if (te.k === "closure") walkStmtsAll(te.inst.body, scanStmts);
      },
      true,
    );
  }
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        const c = te.k === "new" || te.k === "ofield" || te.k === "osetfield" ? te.c : null;
        if (c !== null && c.plain !== true) notOk.add(c.key);
        if (te.k === "new") {
          if (te.into !== null) notOk.add(te.c.key);
          if (te.ctor !== null) withCtor.add(te.c.key);
        }
        if (te.k === "builtin" && te.name === "unsafe.free" && te.info?.c !== undefined)
          notOk.add(te.info.c.key);
        if (te.k === "osetfield") {
          const k = `${te.c.key}|${te.f.name}`;
          if (construction.has(te)) atNew.add(k);
          else if (!ignoreStores) written.add(k);
        }
      },
      true,
    );
  const ok = (c: ClassInst): boolean =>
    c.plain === true &&
    !notOk.has(c.key) &&
    (c.iface === undefined || c.iface.set.every((x) => x.plain === true && !notOk.has(x.key)));
  // R19: a lowered `rc` package's heap-only class (loweredRcHeapClass), and the fields its own constructor stores on `this`
  // (that constructor holding no closure), every other store to them being `written`
  const heapCls = new Map<string, boolean>();
  const rcHeap = (c: ClassInst): boolean => {
    if (tslOptOff("ctorfields")) return false;
    let hit = heapCls.get(c.key);
    if (hit === undefined) {
      hit = c.iface === undefined && c.tail === undefined && loweredRcHeapClass(c.decl);
      heapCls.set(c.key, hit);
    }
    return hit;
  };
  const inCtor = new Set<string>(); // `class|field` stored on `this` by the class's own constructor
  const ctorWritten = new Set<string>(); // `class|field` stored anywhere else
  const builtIn = new Set<string>(); // classes built in place inside another object, or given to `unsafeFree`
  for (const f of typed.funcs) {
    const c = f.owner;
    let self: unknown = null;
    if (c !== undefined && c.ctor === f && rcHeap(c)) {
      let closure = false;
      walkTE(
        f.body,
        (te) => {
          if (te.k === "closure") closure = true;
        },
        true,
      );
      if (!closure) self = f.params[0];
    }
    walkTE(
      f.body,
      (te) => {
        if (te.k === "new" && te.into !== null) builtIn.add(te.c.key);
        if (te.k === "builtin" && te.name === "unsafe.free" && te.info?.c !== undefined)
          builtIn.add(te.info.c.key);
        if (te.k !== "osetfield") return;
        const k = `${te.c.key}|${te.f.name}`;
        if (self !== null && te.c.key === c!.key && te.obj.k === "var" && te.obj.v === self)
          inCtor.add(k);
        // the bug put into R19's part of this rule (tools/r19-tests.ts): a store outside the constructor isn't seen
        else if (!ignoreStores && process.env.TMK_TEST_TSL !== "r19-ctor-store") ctorWritten.add(k);
      },
      true,
    );
  }
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.k !== "ofield" || te.check !== false) return;
        const k = `${te.c.key}|${te.f.name}`;
        if (!ok(te.c)) {
          // R19: a constructor's store on `this` is construction; any other is `written`
          if (
            rcHeap(te.c) &&
            !builtIn.has(te.c.key) &&
            inCtor.has(k) &&
            !ctorWritten.has(k) &&
            te.f.store === "value"
          )
            te.inv = true;
          return;
        }
        const hidden = te.f.name === " cid" && te.c.iface !== undefined && te.f.off === 0;
        const once =
          atNew.has(k) && !written.has(k) && !withCtor.has(te.c.key) && te.f.ty.k === "int";
        if (hidden || once) te.inv = true;
      },
      true,
    );
}

/** Each statement list, nested ones too, given to `f`: a function's body and every block in it. */
function walkStmtsAll(
  list: import("./types.ts").Stmt[],
  f: (l: import("./types.ts").Stmt[]) => void,
): void {
  f(list);
  for (const s of list) for (const b of stmtBodies(s)) walkStmtsAll(b, f);
}

/** A literal whose bytes are all zero: `0` (not `-0`), `0n`, `false`, or `null` (a `0n` of nullish type). */
function isZeroLiteral(te: import("./types.ts").TE): boolean {
  if (te.k === "conv") return isZeroLiteral(te.val) && te.val.ty.k === "nullish";
  if (te.k !== "lit" || te.undef === true) return false;
  const x = te.value;
  return x === false || x === 0n || (typeof x === "number" && Object.is(x, 0));
}

/**
 * Field initialisers of zero that a constructor needn't store, because every object it runs on starts zeroed (SPEC 3.5,
 * "Zeroed construction"). A constructor runs only at a `new`, and every `new` but one built in place inside another object
 * gets memory that is all zero at that moment: a stack object is zero-filled at the `new` itself, a `manual` one is
 * zero-filled after the heap gives it, a `leak` one is fresh from the page source, which hands out zeroed pages, and the bump
 * allocator never hands out a byte twice. A `Slab`'s or an `Rc` store's slot, which is reused, is never constructed in: the
 * object is built on the stack and copied in whole by `placeObject`. A static object is built at compile time. So a store of
 * a zero literal among the initialisers, before anything can have written the field, writes what is there already. A class
 * any of whose objects is built in place (`into`) keeps every store.
 */
export function dropZeroCtorInits(typed: TypedModule): void {
  if (tslOptOff("ctorzero")) return;
  const inPlace = new Set<string>();
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.k === "new" && te.into !== null) inPlace.add(te.c.key);
      },
      true,
    );
  const empty = new Set<import("./types.ts").FuncInst>();
  for (const f of typed.funcs) {
    const c = f.owner;
    const self = f.params[0];
    if (f.ctorInits === undefined || c === undefined || c.ctor !== f || self === undefined)
      continue;
    if (inPlace.has(c.key)) continue;
    const drop = new Set<number>();
    for (let i = 0; i < f.ctorInits && i < f.body.length; i++) {
      const st = f.body[i]!;
      // Only a store to a field of this object, from what can't read or write it, leaves every other field as it was.
      if (st.k !== "expr" || st.e.k !== "osetfield" || st.e.obj.k !== "var" || st.e.obj.v !== self)
        break;
      if (st.e.f.store !== "value") break;
      if (isZeroLiteral(st.e.val)) drop.add(i);
      else if (!initSafe(st.e.val, self)) break;
    }
    if (drop.size > 0) {
      f.body = f.body.filter((_, i) => !drop.has(i));
      f.ctorInits -= drop.size;
      if (f.body.length === 0) empty.add(f);
    }
  }
  // A constructor left with nothing to do isn't called, and isn't there: as if the class had had none.
  if (empty.size === 0) return;
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.k === "new" && te.ctor !== null && empty.has(te.ctor)) te.ctor = null;
      },
      true,
    );
  for (const f of empty) if (f.owner !== undefined && f.owner.ctor === f) f.owner.ctor = null;
  typed.funcs = typed.funcs.filter((f) => !empty.has(f));
}

/** Whether anything in the module is a TSL `new`. */
function hasNew(typed: TypedModule): boolean {
  let found = false;
  for (const f of typed.funcs) walkTE(f.body, (te) => (found ||= te.k === "new"), true);
  return found;
}

/** `@tsl.global-allocator` (SPEC 3.5, D43): how it's written, and at most one in a program. V8 only sees the call, tslc both. */
function checkGlobalAllocators(
  program: ts.Program,
  modules: ts.SourceFile[],
  sink: DiagSink,
): void {
  const checker = program.getTypeChecker();
  const TAG = /\/\*\*(?:(?!\*\/)[\s\S])*@tsl\.global-allocator\b/;
  let first: string | null = null;
  const tagged = (m: ts.SourceFile, n: ts.Node): boolean =>
    TAG.test(m.text.slice(n.getFullStart(), n.getStart(m)));
  const form =
    "it's written `/** @tsl.global-allocator */ const h = globalAllocator(pages);` at the top level, where pages is a top-level function";
  for (const m of modules) {
    const accepted = new Set<ts.Node>();
    for (const st of m.statements) {
      if (!tagged(m, st)) continue;
      const d = ts.isVariableStatement(st) ? st.declarationList.declarations[0] : undefined;
      const init = d?.initializer;
      if (init !== undefined && ts.isCallExpression(init)) accepted.add(init);
      const isConst =
        ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (
        d === undefined ||
        init === undefined ||
        !isConst ||
        !ts.isCallExpression(init) ||
        !isGlobalAllocatorCallee(checker, init)
      ) {
        sink.at(m, st, "TSL1020", `@tsl.global-allocator is on the wrong thing: ${form}`);
        continue;
      }
      const at = `${repoRelative(m.fileName)}:${m.getLineAndCharacterOfPosition(st.getStart(m)).line + 1}:${m.getLineAndCharacterOfPosition(st.getStart(m)).character + 1}`;
      if (first !== null) {
        sink.at(
          m,
          st,
          "TSL1021",
          `a program has at most one global allocator, and this is a second: the first is at ${first}`,
        );
      } else first = at;
      if (!isUnsafeModule(m.fileName)) {
        sink.at(
          m,
          st,
          "TSL5001",
          `naming a global allocator trusts its page source, so this module has to be listed under "unsafeModules" in tsl.json`,
        );
      }
      const arg = init.arguments[0];
      const isTopFunction = (e: ts.Expression | undefined): boolean => {
        if (e === undefined || !ts.isIdentifier(e)) return false;
        const raw = checker.getSymbolAtLocation(e);
        const sym =
          raw !== undefined && raw.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(raw)
            : raw;
        const decl = sym?.declarations?.[0];
        if (decl === undefined) return false;
        if (ts.isFunctionDeclaration(decl)) return ts.isSourceFile(decl.parent);
        return (
          ts.isVariableDeclaration(decl) &&
          decl.initializer !== undefined &&
          ts.isArrowFunction(decl.initializer) &&
          ts.isSourceFile(decl.parent.parent.parent)
        );
      };
      if (!isTopFunction(arg)) {
        sink.at(
          m,
          arg ?? init,
          "TSL5009",
          "globalAllocator takes a top-level function by name: it's called with no environment, whenever memory runs out",
        );
      }
    }
    const walk = (n: ts.Node): void => {
      if (n !== m && !ts.isSourceFile(n.parent) && (ts.isStatement(n) || ts.isClassElement(n))) {
        if (tagged(m, n)) {
          sink.at(m, n, "TSL1020", `@tsl.global-allocator is on the wrong thing: ${form}`);
        }
      }
      if (ts.isClassDeclaration(n) && tagged(m, n)) return;
      if (ts.isCallExpression(n) && !accepted.has(n) && isGlobalAllocatorCallee(checker, n)) {
        if (!m.fileName.endsWith("/ex-std-global.ts")) {
          sink.at(
            m,
            n,
            "TSL1020",
            `globalAllocator with no @tsl.global-allocator tag above it: ${form}`,
          );
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(m);
  }
}

/** Each function's package's memory mode, where it has one. */
function markFuncModes(typed: TypedModule): void {
  for (const f of typed.funcs) {
    const at = f.at?.replace(/:\d+:\d+$/, "");
    const owner = f.owner?.decl as ts.Node | undefined;
    const file = owner?.getSourceFile().fileName ?? (at ? resolve(repoRoot(), at) : null);
    if (file === null) continue;
    const m = packageMemory(file);
    if (m !== "strict") f.memory = m;
  }
}

/** Which functions have a memory mode, and links its runtime if anything here can use it (SPEC 3.5). */
function markMemoryModes(typed: TypedModule, modules: ts.SourceFile[]): void {
  markFuncModes(typed);
  let link = modules.some((m) => packageMemory(m.fileName) !== "strict");
  let std = false;
  for (const f of typed.funcs) {
    walkTE(
      f.body,
      (te) => {
        if (te.k === "builtin" && te.name === "unsafe.setPageSource") link = true;
        if (te.k === "builtin" && te.name === "unsafe.sourcePages") std = true;
      },
      true,
    );
  }
  if (link || std) {
    typed.extraFuncs = [...memoryRtFuncs(), ...(std ? stdRtFuncs() : [])];
    typed.extraGlobals = memoryRtGlobals();
    typed.extraTraps = RT_TRAPS;
  }
}

/** A package's `"cycles": true | false` in tsl.json, for `rc`'s cycle collector (SPEC 9.2). */
function packageCycles(file: string): boolean | undefined {
  const pkg = findTslJson(file);
  if (pkg === null) return undefined;
  const cycles = (pkg as { cycles?: unknown }).cycles;
  return typeof cycles === "boolean" ? cycles : undefined;
}

/** `@tsl/std` is TSL proper's: lowered code has JS's own Map, Set and strings (SPEC 3.5, 4.5, D42, D43). */
function stdInLowered(program: ts.Program): Diag[] {
  const out: Diag[] = [];
  for (const m of ownModules(program)) {
    if (/\/packages\/tsl-std\//.test(m.fileName) || m.fileName.includes("/compiler/rt/")) continue;
    for (const st of m.statements) {
      if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st)) continue;
      const spec = st.moduleSpecifier;
      if (spec === undefined || !ts.isStringLiteral(spec)) continue;
      if (isStdSpecifier(m, spec.text, resolvedFile(program, m, spec))) {
        out.push(
          diagAt(
            m,
            st,
            "TSL1022",
            `tmk lower doesn't take @tsl/std, which is TSL proper's: lowered code has JS's own Map, Set and strings, and a TSL program compiles with tslc`,
          ),
        );
      }
    }
  }
  return out;
}

/** The memory mode for `tmk lower`: the flag, or else the package's, and anything wrong with either. */
function memorySettings(
  program: ts.Program,
  file: string,
  override: string | undefined,
): { memory: LowerMemorySetting; diags: Diag[] } {
  const sf = program.getSourceFile(file)!;
  if (override !== undefined) {
    const rel = repoRelative(file);
    if (
      override !== "strict" &&
      override !== "leak" &&
      override !== "manual" &&
      override !== "rc"
    ) {
      const msg = `--memory is strict, leak, manual or rc, not ${override}`;
      return { memory: "strict", diags: [{ code: "TSL1019", file: rel, line: 1, col: 1, msg }] };
    }
    const std = packageDiags(program, file).filter((d) => d.code === "TSL1018");
    return { memory: override, diags: [...std, ...stdInLowered(program)] };
  }
  const pkg = findTslJson(file);
  if (pkg === null) return { memory: "strict", diags: stdInLowered(program) };
  void sf;
  const memory = packageLowerMemory(file);
  // `rc` is an error for what tslc compiles, and it's what lowering is for (SPEC 3.5).
  const diags = packageDiags(program, file).filter(
    (d) => !(memory === "rc" && d.code === "TSL9001" && d.msg.includes('"memory": "rc"')),
  );
  return { memory, diags: [...diags, ...stdInLowered(program)] };
}

/**
 * Whether `auto`'s class printing prints arrays as @tsl/jsrt's JsArray (D66): only once every benchmark on them is no slower
 * than the direct route (tmk bench memory --classes, M5's pipe-d record), which they are since a byte array's fill is one
 * memset and JsArray's growth zeroes only what it doesn't copy (pipe-e).
 */
export const AUTO_VECTORS = true;

/**
 * Whether `auto`'s class printing prints strings as @tsl/jsrt's JsString (D67): only once every benchmark on them is no
 * slower than the direct route at -O1 and -O2 (the owner's rule, 2026-11-15: -O0 is exempt).
 */
export const AUTO_STRINGS = false;

/**
 * Whether `auto`'s class printing prints `Map` and `Set` as @tsl/jsrt's JsMap and JsSet (D72): only once every benchmark on
 * them is no slower than the direct route at -O1 and -O2, and they run on V8 (D71).
 */
export const AUTO_MAPS = false;

/**
 * R10: whether `auto` builds a lowered `rc` program with strings through the TSL route, its strings the program's own JsStr
 * counted by tslc's expansion (emit-rcstr.ts): only once every `rc` string benchmark is no slower than the direct route at
 * -O1 and -O2 in two quiet runs (M5's R10 record).
 */
export const AUTO_RC_STRINGS = false;

/**
 * Whether `auto` builds lowered `rc` programs through the TSL route (R2): class printing in a lowered `rc` package, counted by
 * tslc's expansion onto @tsl/gc (D74). Only once every `rc` benchmark it takes is no slower than the direct route at -O1 and
 * -O2, and the printed TSL runs on V8 (D71). On since R4 (M5's R4 record): all fourteen cells met it in two quiet runs. In
 * `rc` it takes maps as JsMap and closures as values with it, as the maps and cycles benchmarks are among those measured.
 */
export const AUTO_RC = true;

/**
 * R11: whether `auto` builds a lowered `rc` program with exceptions through the TSL route, desugared by the printer (D68)
 * and counted by tslc's expansion: only once every `rc` exceptions benchmark is no slower than the direct route at -O1 and
 * -O2 (M5's R11 record). On since R23 (M5's R23 record), by instruction counts. Nearly every such program has strings, which
 * `auto` doesn't take in `rc` (AUTO_RC_STRINGS), so in the corpus it takes none yet (route-blockers: `rc` 19 + 0 as before).
 */
export const AUTO_RC_EXC = true;

/**
 * R23: AUTO_RC_EXC put back off (`TMK_R23_OFF=exc`), for tools/r23-pins.ts's comparison. Never set otherwise. On since R23
 * (M5's R23 record): every `rc` exceptions benchmark is no slower than the direct route at -O1 and -O2 (instruction counts:
 * calls that can throw, `try` and `try`/`finally` 1.00; throws 1, 10 and 100 frames up 0.94 to 0.99).
 */
function autoRcExc(): boolean {
  return AUTO_RC_EXC && !(process.env.TMK_R23_OFF ?? "").split(",").includes("exc");
}

/**
 * The memory modes in which `auto`'s class printing prints closure values as environment classes (R3): only where every
 * benchmark on them is no slower than the direct route at -O1 and -O2, and the printed TSL runs on V8 (D71). TMK_EMIT_CLOS=0
 * or 1 says otherwise, in every mode. `rc` since R4, with AUTO_RC. `leak` and `manual` waited for an environment the
 * direct route's call arena gives back to be given back through the TSL route too (corpus/lower/rc/cyc_churn.ts ran out,
 * pipe-d box 28), which tslc's per-call region does since R6 (region.ts); whether they're on is AUTO_CLOSURES_MODES's.
 */
/**
 * R6: closures in `auto` in `leak` and `manual` too, with the per-call region. The cycles benchmark, the one benchmark with
 * closure values, which the printer prints exactly with them: 0.60x the direct route's instructions at -O1 and 0.56x at -O2,
 * and in time, eight quiet runs, `leak` 0.997, 1.011, 1.000, 1.000 at -O1 and 0.988, 0.987, 0.956, 0.997 at -O2, `manual`
 * 0.999, 0.995, 0.997, 0.996 and 0.993, 0.993, 1.034, 0.986: two runs in a row meeting the rule at each level, as R4's
 * switch took (M5's R6 record). On.
 */
export const R6_CLOSURES = true;
export const AUTO_CLOSURES_MODES: readonly string[] = R6_CLOSURES
  ? ["rc", "leak", "manual"]
  : ["rc"];

/** As AUTO_CLOSURES_MODES, but for tools/r6-pins.ts's comparison, which can put R6's switch back (TMK_R6_OFF=closures). */
export function autoClosures(): readonly string[] {
  if (!AUTO_RC) return [];
  return r6Off("closures") ? ["rc"] : AUTO_CLOSURES_MODES;
}
export const AUTO_CLOSURES: readonly string[] = AUTO_CLOSURES_MODES;

/**
 * Whether class printing prints closure values in this mode (R3). A forced route does in `rc`, where they're what the cycles
 * benchmark needs, and since R6 in `leak` and `manual` too, where `auto` does: until tslc's per-call region, the TSL route
 * never freed there what the direct route's call arena does, and corpus/lower/rc/cyc_churn.ts ran out through it alone
 * (M5's R3 and R6 records). TMK_EMIT_CLOS=0 or 1 says so in every mode.
 */
export function closuresIn(memory: string, auto: boolean): boolean {
  const env = process.env.TMK_EMIT_CLOS;
  if (env !== undefined) return env === "1";
  // A forced route prints them wherever `auto` does, and in `rc`, where the cycles benchmark needs them (R3, R6).
  return auto
    ? autoClosures().includes(memory)
    : memory === "rc" || autoClosures().includes(memory);
}

/**
 * Whether `auto`'s class printing prints an exported function taking or giving an object or array (R5): each class that
 * crosses in D36's listed layout, each array placed by an export of its own. Only once every benchmark on it is no slower
 * than the direct route at -O1 and -O2, and the printed TSL runs on V8 and JSC with arguments placed as a native caller
 * places them (D71). Off: bench/memory/boundary_lowered.ts is 1.00x at -O2 but 1.003x to 1.007x in `leak` at -O1 (two quiet
 * runs, M5's R5 record), its arrays' reads checked twice for null and for bounds at -O1, where -O2's value numbering merges
 * them; the classes in D36's layout themselves give the direct route's TIR, but for a byte's load where it loads 4. R8: in
 * `rc` (counted objects crossing, with a native caller's counts printed) 0.97x and 1.05x at -O1, 1.17x and 1.18x at -O2.
 */
export const AUTO_BOUNDARY = false;

/**
 * R9: typed arrays made in functions (a layout class's `array(…)` or a tail, D69, placed by tslc on the stack or in the
 * per-call region), module state that's a typed array, and arrays of booleans and of nothing, which `auto` prints only
 * once each benchmark of them meets the speed rule at -O1 and -O2 (M5's R9 record). TMK_EMIT_R9=0 or 1 says otherwise.
 */
export const AUTO_R9 = false;

/** Whether the printing prints R9's constructs: forced by the route, or `auto`'s choice by AUTO_R9. */
function r9In(auto: boolean): boolean {
  const env = process.env.TMK_EMIT_R9;
  if (env !== undefined) return env === "1";
  return auto ? AUTO_R9 : true;
}

/** Whether the printing prints what crosses an export (R5); TMK_EMIT_BOUNDARY=0 or 1 says so, else `auto` by AUTO_BOUNDARY. */
export function boundaryIn(auto: boolean): boolean {
  const env = process.env.TMK_EMIT_BOUNDARY;
  if (env !== undefined) return env === "1";
  return auto ? AUTO_BOUNDARY && !r6Off("boundary") : true;
}

/**
 * R12 (pile item 7): whether `auto` prints a `strict` program's objects as TSL classes, where the printer prints the program
 * exactly and it has a class to print: what escapes its function in the call arena (tslc places it, as the direct route
 * puts it there), nothing of phase 2 but the classes (emit-tsl.ts's STRICT_CLASSES_ONLY). Only once every benchmark on it
 * is no slower than the direct route at -O1 and -O2 in two quiet runs (`tmk bench memory --classes --strict`, M5's R12
 * record). TMK_EMIT_STRICT=0 or 1 says otherwise. On: bench/memory/strict_lowered.ts's three cells, two quiet runs (load
 * 3.3 to 3.7), at -O1 0.81 to 0.91x and at -O2 0.78 to 0.99x the direct route.
 */
export const AUTO_STRICT_CLASSES = true;

/**
 * R13 (pile item 7): whether `auto`'s class printing in `strict` prints arrays too, as @tsl/jsrt's arena array (JsArenaArray,
 * its buffers the call arena's), and typed arrays made in functions as R9's layout classes and tails, tslc placing each in
 * the call arena; where the printing is exact, as R12's. Only once each benchmark of them is no slower than the direct
 * route at -O1 and -O2 in two quiet runs (`tmk bench memory --classes --strict-arrays`, M5's R13 record). Closure values
 * and exports taking or giving objects in `strict` print where the route is forced, and `auto` takes them as it does in
 * every mode (closuresIn, AUTO_BOUNDARY). TMK_EMIT_STRICT_ARRAYS=0 or 1 says otherwise.
 */
export const AUTO_STRICT_ARRAYS = true;

/** Whether `auto`'s class printing in `strict` prints arrays and typed arrays (R13). */
function strictArraysIn(): boolean {
  const env = process.env.TMK_EMIT_STRICT_ARRAYS;
  if (env !== undefined) return env === "1";
  return AUTO_STRICT_ARRAYS && !r13Off("arrays");
}

/** Whether `auto` tries class printing in `strict` (R12). */
function strictClassesIn(): boolean {
  const env = process.env.TMK_EMIT_STRICT;
  if (env !== undefined) return env === "1";
  return AUTO_STRICT_CLASSES && !r12Off("strict");
}

/**
 * R14 (pile item 9, D62): the reshapes `auto` trusts, by emit-tsl.ts's `reshape` kind. A printing reshaped only by these
 * is taken as a printing exactly is; any other kind leaves the program to the reference, as every reshape did before. A
 * kind is here only once (a) the reshape keeps JS's evaluation order (argued in SPEC D62, R14, and an injected bug that
 * breaks the order for that kind is caught by the differential: tools/r14-tests.ts), (b) the three-way differential
 * agrees on every program it touches, and (c) it's no slower at -O1 and -O2 (M5's R14 record: a micro-benchmark per kind,
 * and every touched program's machine code compared or its cases timed). The four are the lowering's statement-expressions
 * met inside an expression, whose statements the printer puts before the statement holding them, in the order JS runs
 * them, with what was evaluated ahead of them held in a temporary.
 */
export const R14_TRUST = true;
/** R14: whether the trust extends to a program with exceptions (the lowering's `excSource`): off, see untrustedReshapes. */
export const R14_TRUST_EXC = false;
export const TRUSTED_RESHAPES: readonly string[] = [
  "a sequence with statements in a part after the first",
  "statements before an operand",
  "a conditional's arm with statements",
  "a logical operator's right side with statements",
];

/**
 * R14: the printings, by mode, in which `auto` trusts TRUSTED_RESHAPES: where every program and benchmark they touch met the
 * speed rule. Phase 1's printing, everywhere it's built: there each program the kinds touch gives the direct route's TIR,
 * byte for byte, at -O1 and -O2 (tools/r14-tests.ts checks it on every one), so its machine code. Not class printing in any
 * mode: there a reshaped program's arrays and objects are TSL classes, and the benchmarks the kinds touch measured up to
 * 1.34x the direct route (`tmk bench memory --classes --reshapes`: a callback's array made each turn as an arena array or
 * a JsArray, M5's R14 record), the classes' cost, not the reshape's; so `auto` prints such a program as phase 1 does
 * where it can. `rc` has no phase 1 printing (R2), so nothing reshaped is taken there.
 */
export const TRUSTED_IN: Record<string, { phase1: boolean; classes: boolean }> = {
  strict: { phase1: true, classes: false },
  leak: { phase1: true, classes: false },
  manual: { phase1: true, classes: false },
  rc: { phase1: false, classes: false },
};

/**
 * The reshape kinds of a printing `auto` doesn't trust: none means `auto` may take it. TMK_TRUST_RESHAPES=0 trusts none (as
 * before R14), and a `|`-separated list of kinds trusts those instead (measurement only: tools/r14-tests.ts); TMK_R14_OFF=
 * trust is R14's switch off, for tools/r14-pins.ts.
 */
export function untrustedReshapes(
  stats: { restructured: number; reshapedWhy?: Record<string, number>; classes?: boolean },
  r: Pick<DownResult, "excSource">,
  memory: string,
): string[] {
  if (stats.restructured === 0) return [];
  const where = stats.classes === true ? "classes" : "phase1";
  // R15, measurement only: TMK_TRUST_IN, a list of `mode:printing` (`rc:classes`), trusts the kinds there too, so
  // tools/r14-time.ts can time what `auto` would take.
  const extra = (process.env.TMK_TRUST_IN ?? "").split(",").includes(`${memory}:${where}`);
  if (TRUSTED_IN[memory]?.[where] !== true && !extra)
    return [
      `a reshape in ${memory}'s ${where === "classes" ? "class printing" : "phase 1 printing"} (TRUSTED_IN)`,
    ];
  const why = stats.reshapedWhy ?? {};
  const kinds = Object.keys(why).filter((k) => (why[k] ?? 0) > 0);
  // a reshape with no kind said is never trusted
  if (kinds.length === 0) return ["(a reshape with no kind)"];
  // Exceptions: every program with them prints reshaped (a call that can throw is a flag check after it), so none was ever
  // `auto`'s, and their throws measured 1.00 to 1.02x the direct route in `leak` (M5's pipe-h record). Trusting the
  // reshapes mustn't switch them over by the way: they wait for their own speed rule (R14_TRUST_EXC).
  if (r.excSource !== undefined && !R14_TRUST_EXC)
    return ["exceptions, which auto doesn't take reshaped (R14_TRUST_EXC)"];
  const env = process.env.TMK_TRUST_RESHAPES;
  const off = !R14_TRUST || r14Off("trust") || env === "0";
  const trusted = off ? [] : env !== undefined && env !== "" ? env.split("|") : TRUSTED_RESHAPES;
  return kinds.filter((k) => !trusted.includes(k));
}

/** tslc's layouts for a file's layout classes, without compiling its functions. */
export function layoutsOfFile(
  file: string,
): { name: string; size: number; align: number; fields: Record<string, number> }[] {
  return inCompile(() => layoutsIn(file));
}

function layoutsIn(
  file: string,
): { name: string; size: number; align: number; fields: Record<string, number> }[] {
  const program = createTslProgram(file);
  const sf = program.getSourceFile(resolve(file));
  if (sf === undefined) throw new Error(`no source file for ${file}`);
  const sink = new DiagSink(repoRelative(file));
  const modules = modulesOf(program, sf, sink);
  return new NativeElaborator(program, sf, sink, modules).layoutsIn(sf);
}

export interface CompileOutput {
  opt: OptReport;
  tir: Module;
  tirText: string;
  tirHash: string;
  wasm: Uint8Array;
  glue: string;
  jsChecked: string;
  meta: ModuleMeta;
}

/** tslc's options: the optimiser's level, -O0 unless given or set by `TMK_OPT` (SPEC 9.2, D44). */
export interface CompileOptions {
  opt?: OptLevel;
}

export function compileTyped(typed: TypedModule, copts: CompileOptions = {}): CompileOutput {
  const front = lowerToTir(typed);
  const errors = verifyModule(front);
  if (errors.length > 0) throw new Error(`TIR verifier:\n${errors.join("\n")}`);
  // tslc's modules name their roots as the pass manager expects, so -O1 and -O2 remove what's unreached (R1d)
  const { module: tir, report: opt } = optimizeModule(front, {
    ...optFromEnv(copts.opt),
    prune: true,
  });
  // Classes and closures only reach the native backend so far: Wasm and js-checked come with M3's C work.
  const bytes = typed.nativeOnly === true ? new Uint8Array(0) : emitWasm(tir).bytes;
  const meta: ModuleMeta = { exports: {}, strings: Object.fromEntries(typed.strings) };
  for (const f of typed.funcs) {
    if (!f.exported) continue;
    meta.exports[f.jsName] = {
      params: f.params.map((p) => describe(p.ty, typed.strings)),
      ret: describe(f.ret, typed.strings),
    };
  }
  return {
    opt,
    tir,
    tirText: printModule(tir),
    tirHash: tirHash(tir),
    wasm: bytes,
    glue: emitGlue(meta),
    jsChecked: typed.nativeOnly === true ? "" : emitJsChecked(typed),
    meta,
  };
}

/** TSL1012: recursion on a path from a @tsl.noalloc function. */
function checkNoAllocRecursion(program: ts.Program, sf: ts.SourceFile, sink: DiagSink): void {
  const checker = program.getTypeChecker();
  const fns = new Map<ts.Symbol, ts.FunctionDeclaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined) {
      const s = checker.getSymbolAtLocation(st.name);
      if (s !== undefined) fns.set(s, st);
    }
  }
  const callsOf = (fn: ts.FunctionDeclaration): { sym: ts.Symbol; node: ts.CallExpression }[] => {
    const out: { sym: ts.Symbol; node: ts.CallExpression }[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const s = checker.getSymbolAtLocation(n.expression);
        if (s !== undefined && fns.has(s)) out.push({ sym: s, node: n });
      }
      ts.forEachChild(n, walk);
    };
    if (fn.body !== undefined) walk(fn.body);
    return out;
  };
  for (const [, fn] of fns) {
    const comment = sf.text.slice(fn.getFullStart(), fn.getStart(sf));
    if (!/@tsl\.noalloc\b/.test(comment)) continue;
    const onPath = new Set<ts.Symbol>();
    const done = new Set<ts.Symbol>();
    const visit = (f: ts.FunctionDeclaration, s: ts.Symbol): void => {
      onPath.add(s);
      for (const call of callsOf(f)) {
        if (onPath.has(call.sym)) {
          sink.at(
            sf,
            call.node,
            "TSL1012",
            "recursion on a @tsl.noalloc path: the stack isn't bounded",
          );
        } else if (!done.has(call.sym)) visit(fns.get(call.sym)!, call.sym);
      }
      onPath.delete(s);
      done.add(s);
    };
    const sym = checker.getSymbolAtLocation(fn.name!);
    if (sym !== undefined) visit(fn, sym);
  }
}

// --- down-lowering (SPEC 4.5)

export interface LowerRow {
  fn: string;
  file: string;
  line: number;
  kind: "function" | "method" | "closure" | "module";
  outcome: "lowered" | "fallback" | "unreached";
  blocker: string | null;
  note: string;
  hot?: boolean;
}

export interface LowerDiag {
  code: string;
  fn: string;
  file: string;
  line: number;
  col: number;
  blocker: string;
  detail: string;
  suggest: string;
  outcome: "fallback" | "warning";
  blocked_callers: string[];
}

export interface LowerOutput {
  diags: Diag[]; // tsc's: lowering assumes the input is clean
  rows: LowerRow[];
  fallbackDiags: LowerDiag[];
  warnings: LowerDiag[];
  counts: { lowered: number; fallback: number; unreached: number; total: number };
  allocs: { fn: string; loc: string; what: string; where: "stack" | "arena" | "long" }[];
  rounds: number;
  math: string[];
  tir: Module | null;
  tirText: string;
  tirHash: string;
  wasm: Uint8Array | null;
  glue: string;
  meta: DownMeta | null;
  sourceFile: string;
  rc?: RcStats;
  opt?: OptReport;
  cycles?: { classes: string[]; sites: string[] }[];
  cycleCollector?: boolean; // `rc`: the collector is in this module
  tsl?: TslRouteInfo; // the TSL route's program, when it took that route (SPEC 4.5, D62)
  tslSkipped?: string; // `auto`: why the TSL route didn't take it, and the reference did
}

function isNested(n: ts.Node): boolean {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}

/** Every function in the file gets a row, including closures, which follow the function around them. */
function functionRows(
  sf: ts.SourceFile,
  r: DownResult,
  profile: Record<string, number> | null,
): LowerRow[] {
  const rows: LowerRow[] = [];
  const reached = new Set<ts.Node>();
  for (const inst of r.insts) reached.add(inst.owner);
  for (const inst of r.insts) reached.add(inst.decl as ts.Node);
  const add = (n: ts.Node, kind: LowerRow["kind"], enclosing: LowerRow | null): LowerRow => {
    const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    const fb = r.fallback.get(n);
    const name = r.fnNameOf(n);
    let outcome: LowerRow["outcome"] =
      fb !== undefined ? "fallback" : reached.has(n) ? "lowered" : "unreached";
    let note = "";
    if (enclosing !== null) {
      outcome = enclosing.outcome;
      note =
        enclosing.outcome === "lowered" ? `inlined into ${enclosing.fn}` : `inside ${enclosing.fn}`;
    }
    const clones = r.insts.filter((i) => i.decl === n).length;
    if (clones > 1) note = `${clones} specialised copies`;
    const row: LowerRow = {
      fn: name,
      file: repoRelative(sf.fileName),
      line: pos.line + 1,
      kind,
      outcome,
      blocker: fb?.blocker ?? null,
      note,
    };
    if (profile !== null) row.hot = (profile[name] ?? 0) > 0;
    rows.push(row);
    return row;
  };
  const walk = (n: ts.Node, enclosing: LowerRow | null): void => {
    let cur = enclosing;
    if (ts.isFunctionDeclaration(n) && n.body !== undefined)
      cur = add(n, enclosing !== null ? "closure" : "function", enclosing);
    else if (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      cur = add(n, enclosing !== null || isNested(n) ? "closure" : "function", enclosing);
    else if (
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessor(n) ||
      ts.isSetAccessor(n) ||
      ts.isConstructorDeclaration(n)
    )
      cur = add(n, "method", enclosing);
    else if (ts.isClassLike(n) && !n.members.some(ts.isConstructorDeclaration)) {
      const has = n.members.some((m) => ts.isPropertyDeclaration(m) && m.initializer !== undefined);
      if (has) add(n, "method", enclosing);
    }
    ts.forEachChild(n, (c) => {
      walk(c, cur);
    });
  };
  walk(sf, null);
  for (const [node, f] of r.fallback) {
    if (ts.isStatement(node) && !ts.isFunctionDeclaration(node)) {
      rows.push({
        fn: "<module init>",
        file: f.file,
        line: f.line,
        kind: "module",
        outcome: "fallback",
        blocker: f.blocker,
        note: "this top-level statement stays JS",
      });
    }
  }
  return rows;
}

export interface LowerOptions {
  profile?: Record<string, number>;
  memory?: string; // overrides the package's tsl.json
  rc?: Partial<RcOptions>; // test builds of `rc`, and the measurement with elision off
  cycles?: boolean; // the cycle collector under `rc`: --cycles, and it overrides the package's (SPEC 3.5, D41)
  opt?: OptLevel; // the optimiser's level: -O0 unless given or set by `TMK_OPT` (SPEC 9.2, D44)
  // Which route the lowered tree takes to TIR (SPEC 4.5, D62): straight there, the reference, or printed as TSL that tslc
  // compiles. `tsl` throws EmitUnsupported for what the printer can't print yet.
  route?: "direct" | "tsl" | "auto";
  tslDir?: string; // where the TSL route writes its package; build/tsl by default
  // Phase 2 (D62's rulings): objects printed as TSL classes, placed by tslc. Only with the TSL route forced: its TIR isn't
  // the direct route's, so `auto` doesn't take it until the speed rule is shown. TMK_EMIT_CLASSES=1 says the same.
  classes?: boolean;
  // With classes forced, arrays as @tsl/jsrt's JsArray (D66): on unless false.
  vectors?: boolean;
  // With classes forced, strings as @tsl/jsrt's JsString (D67): on unless false.
  strings?: boolean;
  // With classes forced, maps as @tsl/jsrt's JsMap and JsSet (D72): on unless false.
  maps?: boolean;
}

function routeFromEnv(): "direct" | "tsl" | "auto" {
  const r = process.env.TMK_ROUTE;
  return r === "direct" || r === "tsl" ? r : "auto";
}

/** What the TSL route made: the program, where it is, and how much of it is @tsl/lowered's. */
export interface TslRouteInfo {
  text: string;
  file: string;
  modules?: { path: string; text: string }[]; // one TSL module per source module (D65), the root's first
  stats: TslEmit["stats"];
  ms: { emit: number; tslc: number };
  strLayout?: StrLayout; // where the printed strings are @tsl/jsrt's: D36's string ABI as the build laid it out
  rcStrLayout?: RcStrLayout; // R10: in `rc`, where the printed strings are the program's own JsStr
  boundary?: TslEmit["boundary"]; // R5: what crosses an export, as printed, in D36's listed layout (checked)
  // R6: what tslc placed in the per-call region, and the classes it kept in the mode's heap, each with why (region.ts)
  region?: { sites: number; heapSites: number; long: Record<string, string> };
}

/**
 * R5: every class the printing laid out in D36's listed layout (emit-tsl.ts's `layBoundary`) as tslc laid it out: plain (no
 * prefix, references plain pointers, as D36's are), D36's size, and each field at D36's offset. Anything else is a
 * printing this route can't take, so the reference builds it (D62), and a native caller never sees a layout that moved.
 */
export function checkBoundary(typed: TypedModule, b: NonNullable<TslEmit["boundary"]>): void {
  const found = new Set<import("./types.ts").ClassInst>();
  const note = (c: import("./types.ts").ClassInst): void => {
    if (c.tyArgs.length === 0 && !c.key.startsWith("ex-")) found.add(c);
  };
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.ty.k === "cls") note(te.ty.c);
        if (te.k === "new") note(te.c);
      },
      true,
    );
  for (const [id, want] of Object.entries(b.classes)) {
    const c = [...found].find((x) => x.name === want.name);
    if (c === undefined) continue; // nothing in the program makes or reads one: nothing to disagree with
    const bad = (why: string): never => {
      throw new EmitUnsupported(`a class crossing an export (${want.name}, D36 ${id}) ${why} (R5)`);
    };
    // R8: in `rc`, a class tslc's expansion counts: its prefix is the counted slot's, before the object, and its references
    // are plain addresses (untaggedCounted), so a caller reads and writes it as D36 lists, at its address.
    if (c.plain !== true && !untaggedCounted(c.decl))
      bad("that isn't plain, so it has a prefix and tagged references");
    if (c.size !== want.size) bad(`of ${c.size} bytes where D36 lists ${want.size}`);
    for (const [d36, f] of Object.entries(want.fields)) {
      const cf = c.fields.find((x) => x.name === f.name);
      if (cf === undefined || cf.off !== f.off)
        bad(`with ${d36} at ${cf?.off ?? "nowhere"} where D36 lists ${f.off}`);
      // R7: an optional scalar's value field, past its flag, where D36's optional has its value
      if (f.value !== undefined) {
        const vf = c.fields.find((x) => x.name === f.value!.name);
        if (vf === undefined || vf.off !== f.value.off)
          bad(`with ${d36}'s value at ${vf?.off ?? "nowhere"} where D36 lists ${f.value.off}`);
      }
    }
  }
}

/**
 * R7: JsMap's fields a reader of a crossing map's memory needs (its tables, the old ones a move reads from, and the move's
 * positions), and the offset of the JsMap a JsSet holds in place, from the classes as tslc laid them out. Every
 * instantiation in the build has to agree, which they do while those fields come before the two whose size is K's and V's.
 */
export function jsMapLayout(typed: TypedModule): import("./emit-tsl.ts").JsMapLayout {
  const NAMES = [
    "keys",
    "vals",
    "chain",
    "okeys",
    "ovals",
    "ochain",
    "moving",
    "mv",
    "end",
    "to",
    "base",
  ];
  let fields: Record<string, number> | null = null;
  let setMap = -1;
  const seen = new Set<import("./types.ts").ClassInst>();
  const note = (c: import("./types.ts").ClassInst): void => {
    if (seen.has(c) || !c.key.startsWith("ex-")) return;
    seen.add(c);
    if ((c.name === "JsMap" || c.name === "JsSet") && c.plain !== true)
      throw new EmitUnsupported(
        `a crossing map's ${c.name} that isn't plain, so its references are tagged (R7)`,
      );
    if (c.name === "JsMap") {
      const got: Record<string, number> = {};
      for (const n of NAMES) {
        const f = c.fields.find((x) => x.name === n);
        if (f === undefined) throw new EmitUnsupported(`JsMap with no field ${n} (R7)`);
        got[n] = f.off;
        // its tables are JsArrays held in place (D37: each made by the constructor and never assigned again), so a table's
        // header, D36's, is at the field's own offset
        if (
          ["keys", "vals", "chain", "okeys", "ovals", "ochain"].includes(n) &&
          f.store !== "inline"
        )
          throw new EmitUnsupported(`JsMap's ${n} not held in place (R7)`);
      }
      if (fields !== null && JSON.stringify(fields) !== JSON.stringify(got))
        throw new EmitUnsupported("two JsMaps laid out differently where a caller reads them (R7)");
      fields = got;
    } else if (c.name === "JsSet") {
      const f = c.fields.find((x) => x.name === "m");
      if (f === undefined || f.store !== "inline")
        throw new EmitUnsupported("a JsSet whose map isn't held in place (R7)");
      setMap = f.off;
    }
  };
  for (const f of typed.funcs)
    walkTE(
      f.body,
      (te) => {
        if (te.ty.k === "cls") note(te.ty.c);
        if (te.k === "new") note(te.c);
      },
      true,
    );
  if (fields === null) throw new EmitUnsupported("a crossing map with no JsMap (R7)");
  // the injected `map-layout-swap` bug (R7): the layout published with the keys' table where the values' is
  if (process.env.TMK_TEST_EMIT === "map-layout-swap") {
    const f = fields as Record<string, number>;
    [f.keys, f.vals] = [f.vals!, f.keys!];
  }
  return { fields, setMap };
}

/**
 * The TSL route (SPEC 4.5, D62): the lowered tree printed as a TSL package, which tslc checks and elaborates like any other,
 * to the TIR the rest of the pipeline takes. Written under a directory named by the text's hash, so processes running at
 * once never see each other's half-written file.
 */
export function compileViaTsl(
  r: DownResult,
  memory: string,
  rel: string,
  dir?: string,
  onlyExact = false,
  classes = false,
  vectors = true,
  strings = true,
  maps = false,
  closures = true,
  boundary = true,
  r9 = true,
): { front: Module | null; info: TslRouteInfo } {
  const t0 = performance.now();
  const write = (e: TslEmit): string => {
    const hash = createHash("sha256");
    for (const m of e.modules ?? [{ path: "", text: e.text }]) hash.update(m.path).update(m.text);
    const pkg = join(
      dir ?? join(repoRoot(), "build/tsl"),
      hash.update(e.tslJson).digest("hex").slice(0, 16),
    );
    const file = join(pkg, e.modules?.[0]?.path ?? basename(rel).replace(/\.ts$/, "") + ".ts");
    if (!existsSync(file)) {
      const tmp = `${pkg}.${process.pid}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(tmp, "tsl.json"), e.tslJson);
      for (const m of e.modules ?? [{ path: basename(file), text: e.text }]) {
        mkdirSync(dirname(join(tmp, m.path)), { recursive: true });
        writeFileSync(join(tmp, m.path), m.text);
      }
      try {
        renameSync(tmp, pkg);
      } catch {
        // Another process wrote the same package first: its bytes are these.
      }
      rmSync(tmp, { recursive: true, force: true });
    }
    return file;
  };
  // Class printing (phase 2): where tsc can't see a narrowing the TS had, because the printed program reads through a
  // temporary, the site gets `!`, which the lowering proved and which costs nothing in tslc. tsc says where, on a printing
  // with every reference site marked; a few rounds, as a `!` can uncover the next.
  const bangs = new Set<number>();
  // One TSL module per source module (D65) where the program has several, and one file where it can't be printed so.
  let modules = r.sourceFiles.length > 1;
  if (modules) {
    try {
      emitTsl(r, memory, rel, {
        classes,
        vectors,
        strings,
        maps,
        closures,
        boundary,
        r9,
        bangs,
        modules,
      });
    } catch (e) {
      if (!(e instanceof EmitUnsupported)) throw e;
      modules = false;
    }
  }
  if (classes) {
    for (let round = 0; round < 4; round++) {
      const marked = emitTsl(r, memory, rel, {
        classes,
        vectors,
        strings,
        maps,
        closures,
        boundary,
        r9,
        bangs,
        marks: true,
        modules,
      });
      const written = write(marked);
      // Only tsc's errors name `!` sites, and tsc's are all found before elaboration: where there are none, this round
      // ends the loop either way (T2; TMK_COMPILE_REUSE=off elaborates it as before).
      let diags: Diag[];
      if (compileReuse()) diags = checkFileBeforeElab(written);
      else {
        const c = checkFile(written);
        if (c.typed !== null) break;
        diags = c.diags;
      }
      const found = new Set<number>();
      for (const m of marked.modules ?? [{ path: basename(written), text: marked.text }]) {
        const mine = diags.filter((d) => d.file.endsWith(`/${m.path}`) || d.file === m.path);
        for (const k of bangSites(m.text, mine)) found.add(k);
      }
      const fresh = [...found].filter((k) => !bangs.has(k));
      if (fresh.length === 0) break;
      for (const k of fresh) bangs.add(k);
    }
  }
  const e = emitTsl(r, memory, rel, {
    classes,
    vectors,
    strings,
    maps,
    closures,
    boundary,
    r9,
    bangs,
    modules,
  });
  const t1 = performance.now();
  // `auto` takes only what was printed exactly, or reshaped only as it trusts (R14), so the rest needn't be written or
  // checked.
  if (onlyExact && untrustedReshapes(e.stats, r, memory).length > 0)
    return {
      front: null,
      info: {
        text: e.text,
        file: "",
        ...(e.modules !== undefined ? { modules: e.modules } : {}),
        stats: e.stats,
        ms: { emit: t1 - t0, tslc: 0 },
      },
    };
  const file = write(e);
  const c = checkFile(file);
  // R12: in `strict`, an object that can outlive the export call has nowhere to go (a strict package has no heap): the
  // printing is refused, as the printer refuses what it can't print, and `auto` prints the program as phase 1 did.
  if (
    c.typed === null &&
    memory === "strict" &&
    c.diags.length > 0 &&
    c.diags.every(
      (d) => d.code === "TSL3001" && d.msg.includes("a strict package has no heap (R12)"),
    )
  )
    throw new EmitUnsupported(
      `in strict, an object that can outlive the export call (R12): ${c.diags[0]!.msg}`,
    );
  if (c.typed === null)
    throw new Error(
      `tslc rejected the TSL lowered from ${rel} (${repoRelative(file)}):\n${c.diags
        .slice(0, 12)
        .map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.msg}`)
        .join("\n")}`,
    );
  // the injected `boundary-unchecked` bug: a printing whose layout moved, not checked (emit-tsl.ts swaps two fields with it)
  if (e.boundary !== undefined && process.env.TMK_TEST_EMIT !== "boundary-unchecked")
    checkBoundary(c.typed, e.boundary);
  // R7: where JsMap keeps what a native caller reads a crossing map by, as tslc laid the class out
  if (e.boundary?.maps !== undefined) e.boundary.mapLayout = jsMapLayout(c.typed);
  const front = lowerToTir(c.typed);
  const t2 = performance.now();
  return {
    front,
    info: {
      ...(c.typed.strLayout !== undefined ? { strLayout: c.typed.strLayout } : {}),
      ...(c.typed.rcStrLayout !== undefined ? { rcStrLayout: c.typed.rcStrLayout } : {}),
      ...(e.boundary !== undefined ? { boundary: e.boundary } : {}),
      ...(c.typed.region !== undefined
        ? {
            region: {
              sites: c.typed.region.sites,
              heapSites: c.typed.region.heapSites,
              long: Object.fromEntries(c.typed.region.why),
            },
          }
        : {}),
      text: e.text,
      file,
      ...(e.modules !== undefined ? { modules: e.modules } : {}),
      stats: e.stats,
      ms: { emit: t1 - t0, tslc: t2 - t1 },
    },
  };
}

export function lowerFile(file: string, opts: LowerOptions = {}): LowerOutput {
  return inCompile(() => lowerFileIn(file, opts));
}

function lowerFileIn(file: string, opts: LowerOptions): LowerOutput {
  const memoryAsked = opts.memory !== undefined && opts.memory !== "strict";
  let program = createTslProgram(file, memoryAsked);
  const rel = repoRelative(file);
  // By the whole path: a file outside the repo has a relative path starting with "..".
  let sf = program.getSourceFile(resolve(file));
  if (sf === undefined) throw new Error(`no source file for ${file}`);
  const empty: LowerOutput = {
    diags: [],
    rows: [],
    fallbackDiags: [],
    warnings: [],
    counts: { lowered: 0, fallback: 0, unreached: 0, total: 0 },
    allocs: [],
    rounds: 0,
    math: [],
    tir: null,
    tirText: "",
    tirHash: "",
    wasm: null,
    glue: "",
    meta: null,
    sourceFile: rel,
  };
  const settings = memorySettings(program, resolve(file), opts.memory);
  if (settings.diags.length > 0) return { ...empty, diags: settings.diags };
  const tsc = tscDiagnostics(program, sf);
  if (tsc.length > 0) return { ...empty, diags: tsc };
  const memory = settings.memory;
  const cycles = opts.cycles ?? packageCycles(resolve(file));
  const rcOpts = { ...(cycles !== undefined ? { cycles } : {}), ...opts.rc };
  let lowered: DownResult;
  if (memory === "strict") lowered = new DownLower(program, sf, memory, rcOpts).run();
  else {
    // In a memory mode the runtime in compiler/rt is there to reach, and what isn't reached costs nothing (SPEC 4.5).
    if (!memoryAsked) {
      program = createTslProgram(file, true);
      sf = program.getSourceFile(resolve(file))!;
    }
    try {
      lowered = new DownLower(program, sf, memory, rcOpts).run();
    } catch (e) {
      if (!(e instanceof RestartStrRt)) throw e;
      lowered = new DownLower(program, sf, memory, rcOpts, true).run();
    }
  }
  const r = lowered;
  // The TSL route in `rc` prints the tree before counts (R2): tslc's expansion places them in the printed classes (D74).
  const uncounted = (): DownResult => {
    const o = { ...rcOpts, uncounted: true };
    try {
      return new DownLower(program, sf!, memory, o).run();
    } catch (e) {
      if (!(e instanceof RestartStrRt)) throw e;
      return new DownLower(program, sf!, memory, o, true).run();
    }
  };
  const rows = functionRows(sf, r, opts.profile ?? null);
  const callersOf = new Map<ts.Node, string[]>();
  const fallbackDiags: LowerDiag[] = [];
  for (const [node, f] of r.fallback) {
    const b = BLOCKERS[f.blocker] ?? BLOCKERS.unsupported!;
    fallbackDiags.push({
      code: b.code,
      fn: r.fnNameOf(node),
      file: f.file,
      line: f.line,
      col: f.col,
      blocker: f.blocker,
      detail: f.detail,
      suggest: b.suggest,
      outcome: "fallback",
      blocked_callers: f.blockedCallers.concat(callersOf.get(node) ?? []),
    });
  }
  // The route (SPEC 4.5, D62): TS -> TSL -> tslc wherever the printer can print the program, which is where the dual-route
  // differential (`tmk milestone pipe-a`) has shown the two agree, and the direct route, the reference, everywhere else.
  // `route` or TMK_ROUTE=direct|tsl forces one; `tsl` forced on a program the printer can't print is an error.
  const route = opts.route ?? routeFromEnv();
  let front: Module | null = null;
  let tsl: TslRouteInfo | undefined;
  let tslSkipped: string | undefined;
  let strictClasses = false; // R12: `auto` took class printing in `strict`
  let classPrinted = false; // R13: the TSL route printed classes (forced or `auto`'s)
  // `rc` (R2): only class printing, in a lowered `rc` package that tslc's expansion counts (D74); phase 1's printing has no
  // counts to print, and `auto` takes it only where AUTO_RC says the speed rule was met.
  const rcVia =
    memory === "rc" &&
    route !== "direct" &&
    (route === "tsl"
      ? (opts.classes ?? process.env.TMK_EMIT_CLASSES === "1")
      : AUTO_RC &&
        opts.classes !== false &&
        process.env.TMK_EMIT_CLASSES !== "0" &&
        // R4: a build of D39's counted heap with an option of its own (the collector off, a test build's checks or
        // counters, elision off, a probe or a fault put in) is that heap's, which only the direct route has
        cycles !== false &&
        Object.keys(opts.rc ?? {}).length === 0);
  if (route !== "direct" && (memory !== "rc" || rcVia)) {
    try {
      // `auto` switches over only what the printer printed exactly: where it had to reshape a loop or a branch, or move
      // an operand, the TIR can differ, and that hasn't shown parity yet, so the reference compiles it (D62). R14: but for
      // the reshapes it trusts (TRUSTED_RESHAPES), which keep JS's order and met the speed rule kind by kind.
      const classes = route === "tsl" && (opts.classes ?? process.env.TMK_EMIT_CLASSES === "1");
      // `auto` takes class printing (D64) in `leak` and `manual` wherever it prints the program unreshaped: it met the speed
      // rule on every benchmark it takes (pipe-b box 9). Where it can't, phase 1's printing, then the reference, as before.
      // TMK_EMIT_CLASSES=0 or `classes: false` turns it off.
      const autoClasses =
        route === "auto" &&
        (memory === "leak" || memory === "manual" || memory === "rc") &&
        opts.classes !== false &&
        process.env.TMK_EMIT_CLASSES !== "0";
      let via: ReturnType<typeof compileViaTsl> | null = null;
      if (autoClasses) {
        try {
          // Arrays as JsArray (D66) only once they met the speed rule; TMK_EMIT_VECS=0 or 1 says otherwise.
          const vecs =
            process.env.TMK_EMIT_VECS !== undefined
              ? process.env.TMK_EMIT_VECS === "1"
              : AUTO_VECTORS;
          // Strings as JsString (D67) likewise, once they meet it; TMK_EMIT_STRS=0 or 1 says otherwise. In `rc` they're the
          // program's own JsStr (R10), AUTO_RC_STRINGS's.
          const strs =
            process.env.TMK_EMIT_STRS !== undefined
              ? process.env.TMK_EMIT_STRS === "1"
              : memory === "rc"
                ? AUTO_RC_STRINGS
                : AUTO_STRINGS;
          // Maps as JsMap (D72) likewise; TMK_EMIT_MAPS=0 or 1 says otherwise. In `rc`, AUTO_RC's: the number-keyed and
          // object-keyed maps benchmarks are among the rc benchmarks it was measured on (R4).
          const maps =
            process.env.TMK_EMIT_MAPS !== undefined
              ? process.env.TMK_EMIT_MAPS === "1"
              : memory === "rc"
                ? AUTO_RC
                : AUTO_MAPS;
          via = compileViaTsl(
            memory === "rc" ? uncounted() : r,
            memory,
            rel,
            opts.tslDir,
            true,
            true,
            vecs,
            strs,
            maps,
            closuresIn(memory, true),
            boundaryIn(true),
            r9In(true),
          );
          if (via.front === null) {
            // R14: say which reshapes `auto` didn't trust, for route-blockers
            const u = untrustedReshapes(via.info.stats, r, memory);
            if (u.length > 0)
              tslSkipped = `classes: reshaped as auto doesn't trust: ${u.join(", ")}`;
            via = null;
          }
          // R11: exceptions in `rc` print, counted by the expansion, but `auto` doesn't take them (AUTO_RC_EXC)
          else if (memory === "rc" && via.info.stats.rcExc === true && !autoRcExc()) {
            tslSkipped = "exceptions in rc, which auto doesn't take yet (AUTO_RC_EXC, R11)";
            via = null;
          }
        } catch (e) {
          tslSkipped = `classes: ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 200)}` : String(e)}`;
        }
      }
      // R12: in `strict`, class printing where it prints the program exactly and the program has a class, its objects and
      // nothing else of phase 2; else phase 1's printing, as before.
      if (
        via === null &&
        route === "auto" &&
        memory === "strict" &&
        opts.classes !== false &&
        process.env.TMK_EMIT_CLASSES !== "0" &&
        strictClassesIn()
      ) {
        try {
          // First the printing alone, which costs little: only a program it prints exactly, with a class, is checked and
          // compiled through it (most `strict` programs have no object, or an array, and print as phase 1 did at once).
          // R13: arrays and typed arrays too where AUTO_STRICT_ARRAYS says, and closure values and the boundary as `auto`
          // takes them in every mode; a program whose only class is the arena array counts as one with a class.
          const arrays = strictArraysIn();
          const clos = closuresIn(memory, true);
          const bound = boundaryIn(true);
          const first = emitTsl(r, memory, rel, {
            classes: true,
            vectors: arrays,
            strings: false,
            maps: false,
            closures: clos,
            boundary: bound,
            r9: arrays,
            bangs: new Set(),
            modules: r.sourceFiles.length > 1,
          });
          const hasClass = (t: string): boolean =>
            /^(export )?class /m.test(t) || /\bJsArenaArray\b/.test(t);
          const firstTexts = first.modules?.map((m) => m.text) ?? [first.text];
          if (untrustedReshapes(first.stats, r, memory).length > 0 || !firstTexts.some(hasClass))
            throw new EmitUnsupported(
              "in strict, nothing to print as a class, or reshaped as auto doesn't trust (R12, R14)",
            );
          const v = compileViaTsl(
            r,
            memory,
            rel,
            opts.tslDir,
            true,
            true,
            arrays,
            false,
            false,
            clos,
            bound,
            arrays,
          );
          const texts = v.info.modules?.map((m) => m.text) ?? [v.info.text];
          if (v.front !== null && texts.some(hasClass)) {
            via = v;
            strictClasses = true;
          }
        } catch (e) {
          tslSkipped = `strict classes: ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 200)}` : String(e)}`;
        }
      }
      // In `rc` nothing but class printing has counts: where it couldn't print, the direct route compiles it.
      if (via === null && memory === "rc" && route !== "tsl")
        throw new EmitUnsupported(`rc: ${tslSkipped ?? "class printing didn't take it"}`);
      via ??= compileViaTsl(
        memory === "rc" ? uncounted() : r,
        memory,
        rel,
        opts.tslDir,
        route !== "tsl",
        classes,
        opts.vectors !== false,
        opts.strings ?? process.env.TMK_EMIT_STRS !== "0",
        opts.maps ?? process.env.TMK_EMIT_MAPS !== "0",
        closuresIn(memory, route !== "tsl"),
        boundaryIn(route !== "tsl"),
        r9In(route !== "tsl"),
      );
      tsl = via.info;
      front = via.front;
      classPrinted = classes || strictClasses;
      if (front === null && route !== "tsl") {
        const u = untrustedReshapes(via.info.stats, r, memory);
        if (u.length > 0) tslSkipped = `reshaped as auto doesn't trust: ${u.join(", ")}`;
      }
    } catch (e) {
      // `auto` never fails a build the reference can make: what the TSL route couldn't take is said, and the reference
      // compiles it. Forced (`tsl`), and in `tmk milestone pipe-a`, a failure is a failure.
      if (route === "tsl") throw e;
      tslSkipped =
        e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 300)}` : String(e);
    }
  } else if (route === "tsl") throw new EmitUnsupported(`the ${memory} mode`);
  front ??= lowerToTir(r.typed);
  const errors = verifyModule(front);
  if (errors.length > 0) throw new Error(`TIR verifier:\n${errors.join("\n")}`);
  const { module: tir, report: opt } = optimizeModule(front, optFromEnv(opts.opt));
  // A memory mode is native only: there's no page source, and no JS glue, on the other side of Wasm.
  let bytes: Uint8Array | null = null;
  if (memory === "strict") {
    try {
      bytes = emitWasm(tir).bytes;
    } catch (e) {
      // R12: `auto` never fails a build the reference can make: a class printing in `strict` whose TIR the Wasm backend
      // can't take is printed as phase 1 did.
      if (!strictClasses) throw e;
      return lowerFileIn(file, { ...opts, classes: false });
    }
  }
  const meta = r.meta;
  if (tsl?.stats.jsStrings === true && front !== null) {
    // D36's string ABI as the build laid JsFlat and JsView out (pipe-split): a build whose strings are JsString has it.
    if (tsl.strLayout === undefined)
      throw new Error("strings printed as JsString with no layout to publish");
    meta.strAbs = true;
    meta.strLayout = tsl.strLayout;
  }
  if (tsl?.stats.rcExc === true && front !== null && meta.exc !== undefined)
    // R11: a taken exception's count is the caller's, given back by the module's own release (4.5's ABI in `rc`)
    meta.exc = { ...meta.exc, release: "__exc_release" };
  if (tsl?.stats.rcStrAbi === true && front !== null) {
    // R10: in `rc` a string crosses as the program's own JsStr, laid out as the build publishes, and a native caller counts
    // it by the module's own pair, as it counts an object it's given (R8): each placed string and each result released
    if (tsl.rcStrLayout === undefined)
      throw new Error("strings printed as JsStr in rc with no layout to publish");
    meta.rcStr = {
      layout: tsl.rcStrLayout,
      retain: "__rc_retain_str",
      release: "__rc_release_str",
    };
    meta.rcTsl = { collect: "__rc_collect", live: "__rc_live", steps: "__rc_steps" };
  }
  // R13: a `strict` build's objects as TSL classes: a reference crossing an export is the Wasm backend's i64 (glue-down.ts)
  if (memory === "strict" && front !== null && classPrinted) meta.refI64 = true;
  if (tsl?.boundary !== undefined && front !== null) {
    // R5: D36's layouts are the same, listed and checked; what the build adds is how each array is placed (the export
    // that makes a JsArray), and for a host caller of the printed TSL (D71), each class's TSL name and fields' names.
    meta.tslClasses = tsl.boundary.classes;
    // R7: a crossing map is a JsMap or a JsSet, which a native caller builds through its surface exports and a reader of
    // its memory reads by JsMap's layout
    if (tsl.boundary.maps !== undefined && tsl.boundary.mapLayout !== undefined)
      meta.tslMaps = { kinds: tsl.boundary.maps, layout: tsl.boundary.mapLayout };
    for (const [id, place] of Object.entries(tsl.boundary.vecs)) {
      const h = meta.heap[id];
      if (h?.k === "vec") h.place = place;
    }
    // R8: in `rc` every object and array that crosses is counted through the TSL route (there's no arena for what the
    // direct route proved call-bounded), so each is `long`, and a caller places, retains and releases it by its own
    // exports; a typed array crosses only borrowed (a lowered rc package keeps none, nor makes one), so it isn't
    if (tsl.boundary.rc !== undefined) {
      for (const [id, x] of Object.entries(tsl.boundary.rc)) {
        const h = meta.heap[id];
        if (h === undefined) continue;
        h.long = true;
        if (x.place !== undefined) (h as { place?: string }).place = x.place;
        h.retain = x.retain;
        h.release = x.release;
      }
      const unlong = (d: import("./down.ts").Desc | undefined): void => {
        if (d === undefined) return;
        if (d.k === "opt") unlong(d.of);
        if (d.k === "arr") delete d.long;
      };
      for (const e of Object.values(meta.exports)) {
        e.params.forEach(unlong);
        unlong(e.ret);
      }
      for (const h of Object.values(meta.heap)) {
        if (h.k === "vec") unlong(h.elem);
        else for (const f of h.fields) unlong(f.ty);
      }
      meta.rcTsl = { collect: "__rc_collect", live: "__rc_live", steps: "__rc_steps" };
    }
  }
  for (const t of tir.traps) if (t.msg !== undefined) meta.traps[String(t.code)] = t.msg;
  if (
    Object.keys(meta.exports).some((k) => meta.exports[k]!.fallback === true) ||
    Object.keys(meta.shims).length > 0
  ) {
    meta.fallbackFile = sf.fileName.replace(/.*\//, "").replace(/\.ts$/, ".fallback.mjs");
  }
  const counts = {
    lowered: rows.filter((x) => x.outcome === "lowered").length,
    fallback: rows.filter((x) => x.outcome === "fallback").length,
    unreached: rows.filter((x) => x.outcome === "unreached").length,
    total: rows.length,
  };
  return {
    diags: [],
    rows,
    fallbackDiags,
    warnings: r.warnings.map((w) => ({
      code: w.code,
      fn: w.fn,
      file: w.loc.split(":")[0]!,
      line: Number(w.loc.split(":")[1]),
      col: Number(w.loc.split(":")[2]),
      blocker: "hot-call-to-fallback",
      detail: w.detail,
      suggest: BLOCKERS["hot-call-to-fallback"]!.suggest,
      outcome: "warning",
      blocked_callers: [],
    })),
    counts,
    allocs: r.allocs.map((a) => ({
      fn: a.fn,
      loc: a.loc,
      what: a.what,
      where: a.stack() !== null ? "stack" : a.long?.() === true ? "long" : "arena",
    })),
    rounds: r.rounds,
    math: r.usedMath,
    tir,
    tirText: printModule(tir),
    tirHash: tirHash(tir),
    wasm: bytes,
    glue: memory === "strict" ? emitDownGlue(meta) : "",
    meta,
    sourceFile: rel,
    ...(r.rc !== undefined ? { rc: r.rc } : {}),
    opt,
    ...(r.cycles !== undefined ? { cycles: r.cycles } : {}),
    ...(r.cycleCollector !== undefined ? { cycleCollector: r.cycleCollector } : {}),
    ...(tsl !== undefined ? { tsl } : {}),
    ...(tslSkipped !== undefined ? { tslSkipped } : {}),
  };
}

/** The whole module as JS, for the functions that stayed JS, with those names exported. */
export function fallbackModuleText(file: string, names: string[]): string {
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
      useDefineForClassFields: true,
    },
    fileName: file,
  });
  const parsed = ts.createSourceFile("out.mjs", out.outputText, ts.ScriptTarget.ES2022, false);
  const already = new Set<string>();
  for (const st of parsed.statements) {
    const exported =
      ts.canHaveModifiers(st) &&
      ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) {
      const isDefault =
        ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
      already.add(isDefault ? "default" : (st.name?.text ?? ""));
    } else if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) already.add(d.name.getText(parsed));
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause !== undefined &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const e of st.exportClause.elements) already.add(e.name.text);
    }
  }
  const extra = names.filter((n) => !already.has(n));
  return `${out.outputText.replace(/\.ts(["'])/g, ".fallback.mjs$1")}
${
  extra.length > 0
    ? `export { ${extra.join(", ")} };
`
    : ""
}`;
}
