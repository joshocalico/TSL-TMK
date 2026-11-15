// What a gate unit's code can reach, declaration by declaration (SPEC 8.3, D51): `tmk test --changed` and `tmk gate --changed`
// select a unit when a change reaches it. A file of the test code (tools/) is cut into nodes: each top-level declaration, the
// module's own top-level code (its "(init)", which runs whenever the module is loaded, and so includes every initialiser that
// can do anything), each `M.unit` call of a milestone's define function and the rest of that function ("(define)", which runs
// in every one of its units' jobs), and each step of the quick tier. A node depends on the nodes it names, on the "(init)" of
// every module it reaches into, and, for anything outside tools/ or reached only by its path (a script a child runs, a worker),
// on that file and everything it can load, whole. When in doubt it takes more: a namespace used other than by a property name
// is the whole module; a name that could be local or top-level is taken as top-level.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const INIT = "(init)";
export const DEFINE = "(define)";
export const STEPS = "(steps)";
/** A module's command-line code, `if (import.meta.main) ...`: it runs only when the module is a process's script, run whole. */
export const MAIN = "(main)";
/** The whole of a module: what a reference resolves to when it can't be narrowed. */
export const WHOLE = "*";

export interface Node {
  name: string;
  hash: string;
  /** Other nodes, "file#name". */
  refs: Set<string>;
  /** Files reached whole: outside tools/, or named by a path (a child's script, a worker, a pinned file). */
  files: Set<string>;
  dirs: Set<string>;
}

export interface ModuleInfo {
  file: string;
  nodes: Map<string, Node>;
  /** Exported name to its node's name, or to another module's export. */
  exports: Map<string, string | { from: string; name: string }>;
  starFrom: string[];
  /** Where each node's pieces are, by character offset, for mapping what ran back to nodes (tools/deps-check.ts). */
  spans: { name: string; start: number; end: number }[];
}

/** A file of the test code: what's cut into nodes. Anything else is reached whole. */
export function analysable(file: string): boolean {
  return /^tools\/.*\.ts$/.test(file) && !file.endsWith(".d.ts");
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

const LITERAL = /["'`]((?:\.\.?\/|[\w@][\w@.-]*\/)[\w@./-]*|SPEC\.md[\w.-]*)["'`]/g;

/** As registry.ts's namedPaths: files and directories a piece of source names, from its own directory and from the root. */
function named(text: string, fromDir: string, files: Set<string>, dirs: Set<string>): void {
  for (const m of text.matchAll(LITERAL)) {
    const lit = m[1]!;
    const tries = lit.startsWith(".") ? [resolve(fromDir, lit)] : [join(ROOT, lit)];
    if (lit.startsWith("@tsl/")) tries.push(join(ROOT, "packages", `tsl-${lit.slice(5)}`));
    for (const t of tries) {
      if (!t.startsWith(ROOT) || !existsSync(t)) continue;
      const rel = relative(ROOT, t);
      if (
        rel === "" ||
        rel.startsWith("..") ||
        rel.startsWith("build") ||
        rel.startsWith("node_modules")
      )
        continue;
      if (statSync(t).isDirectory()) dirs.add(rel);
      else files.add(rel);
    }
  }
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a package: node:*, typescript; @tsl/* is named as a path
  const t = resolve(dirname(join(ROOT, fromFile)), spec);
  if (!existsSync(t)) return null;
  return relative(ROOT, t);
}

/** Is this expression something that can run code when evaluated? Literals, functions and plain shapes of them can't. */
function inert(e: ts.Expression | undefined): boolean {
  if (e === undefined) return true;
  if (
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    ts.isClassExpression(e) ||
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isIdentifier(e) // a name: reading it runs nothing (undefined, or another top-level binding)
  )
    return true;
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e))
    return inert(e.expression);
  if (ts.isPrefixUnaryExpression(e)) return inert(e.operand);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => inert(x as ts.Expression));
  if (ts.isObjectLiteralExpression(e))
    return e.properties.every(
      (p) =>
        (ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          inert(p.initializer)) ||
        ts.isShorthandPropertyAssignment(p) ||
        ((ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) &&
          !ts.isComputedPropertyName(p.name)),
    );
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => inert(s.expression));
  return false;
}

/** The expression an `import(...)` (or a namespace) stands for, past `await`, parentheses, casts and timedModule/timedFn. */
function outerOf(e: ts.Node): ts.Node {
  for (;;) {
    const p = e.parent;
    if (
      p !== undefined &&
      (ts.isAwaitExpression(p) ||
        ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isSatisfiesExpression(p))
    ) {
      e = p;
      continue;
    }
    if (
      p !== undefined &&
      ts.isCallExpression(p) &&
      ts.isIdentifier(p.expression) &&
      (p.expression.text === "timedModule" || p.expression.text === "timedFn") &&
      p.arguments.includes(e as ts.Expression)
    ) {
      e = p;
      continue;
    }
    return e;
  }
}

/** Which exports of a module a use takes: property names, or the whole module. */
function usedNames(use: ts.Node, scope: ts.Node): string[] {
  const p = use.parent;
  if (p === undefined) return [WHOLE];
  if (ts.isPropertyAccessExpression(p) && p.expression === use) return [p.name.text];
  if (
    ts.isElementAccessExpression(p) &&
    p.expression === use &&
    ts.isStringLiteralLike(p.argumentExpression)
  )
    return [p.argumentExpression.text];
  if (ts.isVariableDeclaration(p) && p.initializer === use) {
    if (ts.isObjectBindingPattern(p.name)) {
      const out: string[] = [];
      for (const el of p.name.elements) {
        if (el.dotDotDotToken !== undefined) return [WHOLE];
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) out.push(key.text);
        else return [WHOLE];
      }
      return out;
    }
    if (ts.isIdentifier(p.name)) return bindingUses(p.name.text, p.name, scope);
  }
  return [WHOLE];
}

/** Every use of a name bound to a module, in a scope: what each takes of it. */
function bindingUses(name: string, decl: ts.Node, scope: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== decl) {
      const p = n.parent;
      const isPropName = p !== undefined && ts.isPropertyAccessExpression(p) && p.name === n;
      const isTypePos = p !== undefined && (ts.isTypeQueryNode(p) || ts.isQualifiedName(p));
      if (!isPropName && !isTypePos) out.push(...usedNames(n, scope));
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

interface Binding {
  file: string; // the module it comes from
  name: string; // its export, or WHOLE for a namespace
}

const modMemo = new Map<string, ModuleInfo | null>();

/** A tools/ module cut into nodes, or null if it isn't one. */
export function moduleInfo(file: string): ModuleInfo | null {
  if (modMemo.has(file)) return modMemo.get(file)!;
  const abs = join(ROOT, file);
  if (!analysable(file) || !existsSync(abs)) {
    modMemo.set(file, null);
    return null;
  }
  const info = parseModule(file, readFileSync(abs, "utf8"));
  modMemo.set(file, info);
  return info;
}

/** Cuts a module's text into nodes. Exported for the baseline, which keeps each node's hash. */
export function parseModule(file: string, text: string): ModuleInfo {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const imports = new Map<string, Binding>();
  const topNames = new Set<string>();
  const exports = new Map<string, string | { from: string; name: string }>();
  const starFrom: string[] = [];
  const isMilestone = /^tools\/milestones\/[\w-]+\.ts$/.test(file);
  const isQuick = file === "tools/quick.ts";

  // Parts: [nodeName, AST nodes whose text and references are its].
  const parts = new Map<string, ts.Node[]>();
  const add = (name: string, n: ts.Node): void => {
    const l = parts.get(name);
    if (l === undefined) parts.set(name, [n]);
    else l.push(n);
  };
  // Pieces cut out of a part (a unit's call out of its define function): skipped when the part is walked.
  const cut = new Set<ts.Node>();

  const exported = (s: ts.Statement): boolean =>
    ts.canHaveModifiers(s) &&
    (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (s: ts.Statement): boolean =>
    ts.canHaveModifiers(s) &&
    (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      add(INIT, s);
      const from = ts.isStringLiteral(s.moduleSpecifier)
        ? resolveSpec(file, s.moduleSpecifier.text)
        : null;
      const c = s.importClause;
      if (from === null || c === undefined || c.isTypeOnly) continue;
      if (c.name !== undefined) imports.set(c.name.text, { file: from, name: "default" });
      const nb = c.namedBindings;
      if (nb !== undefined && ts.isNamespaceImport(nb))
        imports.set(nb.name.text, { file: from, name: WHOLE });
      else if (nb !== undefined)
        for (const el of nb.elements) {
          if (el.isTypeOnly) continue;
          imports.set(el.name.text, {
            file: from,
            name: (el.propertyName ?? el.name).text,
          });
        }
      continue;
    }
    if (ts.isExportDeclaration(s)) {
      add(INIT, s);
      const from =
        s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier)
          ? resolveSpec(file, s.moduleSpecifier.text)
          : null;
      if (s.exportClause === undefined) {
        if (from !== null) starFrom.push(from);
        continue;
      }
      if (ts.isNamedExports(s.exportClause))
        for (const el of s.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          exports.set(el.name.text, from !== null ? { from, name: local } : local);
        }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(s) ||
        ts.isClassDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isEnumDeclaration(s)) &&
      s.name !== undefined
    ) {
      const name = s.name.text;
      topNames.add(name);
      if (exported(s)) exports.set(isDefault(s) ? "default" : name, name);
      // A class runs code when it's declared (static blocks and initialisers, decorators): its module's own code takes it too.
      if (ts.isClassDeclaration(s) && classRuns(s)) add(INIT, s.name);
      // An enum is evaluated where it's declared: only a computed member runs anything.
      if (ts.isEnumDeclaration(s) && s.members.some((m) => !inert(m.initializer)))
        add(INIT, s.name);
      if (isMilestone && ts.isFunctionDeclaration(s) && name.startsWith("define") && s.body) {
        // A milestone's define function: each `M.unit("id", ...)` statement is that unit's own; the rest is shared.
        for (const st of s.body.statements) {
          const id = unitIdOf(st);
          if (id !== null) {
            add(`unit:${id}`, st);
            cut.add(st);
          }
        }
        add(DEFINE, s);
        exports.set(name, DEFINE);
        continue;
      }
      if (isQuick && ts.isFunctionDeclaration(s) && name === "steps" && s.body) {
        // The quick tier's steps: each element of the array `steps` returns is its step's own, by number; the rest is shared.
        const ret = s.body.statements.find(
          (x): x is ts.ReturnStatement =>
            ts.isReturnStatement(x) &&
            x.expression !== undefined &&
            ts.isArrayLiteralExpression(x.expression),
        );
        if (ret !== undefined) {
          (ret.expression as ts.ArrayLiteralExpression).elements.forEach((el, i) => {
            add(`step:${i + 1}`, el);
            // Building the list runs every element's construction: what it calls, outside its functions, is every step's.
            // An element whose construction is anything but helpers called with plain arguments is every step's, whole.
            if (constructionPlain(el)) {
              cut.add(el);
              for (const id of constructionNames(el)) add(STEPS, id);
            }
          });
        }
        add(STEPS, s);
        exports.set(name, STEPS);
        continue;
      }
      add(name, s);
      continue;
    }
    if (ts.isVariableStatement(s)) {
      const exp = exported(s);
      for (const d of s.declarationList.declarations) {
        const names: string[] = [];
        const collect = (b: ts.BindingName): void => {
          if (ts.isIdentifier(b)) names.push(b.text);
          else for (const el of b.elements) if (!ts.isOmittedExpression(el)) collect(el.name);
        };
        collect(d.name);
        for (const n of names) {
          topNames.add(n);
          if (exp) exports.set(n, n);
        }
        if (ts.isIdentifier(d.name) && inert(d.initializer)) add(d.name.text, d);
        else {
          // Its initialiser can run code, at load: the module's own code. Each name it binds is read through that.
          add(INIT, d);
          for (const n of names) add(n, d.name);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(s)) {
      add(INIT, s);
      exports.set("default", INIT);
      continue;
    }
    // Code only a module run as a script runs: its own node, which no import reaches.
    if (ts.isIfStatement(s) && entryChain(s, file)) {
      add(MAIN, s);
      continue;
    }
    // Anything else at the top level runs when the module loads.
    add(INIT, s);
  }
  if (!parts.has(INIT)) parts.set(INIT, []);

  const nodes = new Map<string, Node>();
  const spans: { name: string; start: number; end: number }[] = [];
  for (const [name, list] of parts)
    for (const r of list) spans.push({ name, start: r.getStart(sf), end: r.getEnd() });
  for (const [name, list] of parts) {
    const refs = new Set<string>();
    const files = new Set<string>();
    const dirs = new Set<string>();
    let hashed = "";
    for (const root of list) {
      const start = root.getStart(sf);
      const own = root.getText(sf);
      const cutHoles: [number, number][] = []; // pieces that are their own nodes
      const specHoles: [number, number][] = []; // module specifiers: reaching a module is by what's used of it
      const visit = (n: ts.Node): void => {
        if (n !== root && cut.has(n)) {
          cutHoles.push([n.getStart(sf) - start, n.getEnd() - start]);
          return;
        }
        // Types are erased: what they name isn't run.
        if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
        if (ts.isIdentifier(n)) {
          const p = n.parent;
          const notARead =
            p !== undefined &&
            ((ts.isPropertyAccessExpression(p) && p.name === n) ||
              (ts.isPropertyAssignment(p) && p.name === n) ||
              (ts.isMethodDeclaration(p) && p.name === n) ||
              (ts.isPropertyDeclaration(p) && p.name === n) ||
              ts.isImportSpecifier(p) ||
              ts.isImportClause(p) ||
              ts.isNamespaceImport(p) ||
              ts.isExportSpecifier(p));
          if (!notARead) {
            const b = imports.get(n.text);
            if (b !== undefined) {
              if (b.name === WHOLE)
                for (const u of usedNames(n, root)) refs.add(`${b.file}#\0${u}`);
              else refs.add(`${b.file}#\0${b.name}`);
            } else if (topNames.has(n.text)) refs.add(`${file}#${n.text}`);
          }
        }
        if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments.length > 0
        ) {
          const a = n.arguments[0]!;
          if (ts.isStringLiteralLike(a)) {
            specHoles.push([a.getStart(sf) - start, a.getEnd() - start]);
            const from = resolveSpec(file, a.text);
            if (from !== null)
              for (const u of usedNames(outerOf(n), root)) refs.add(`${from}#\0${u}`);
          }
        }
        if (
          (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier !== undefined
        ) {
          const spec = n.moduleSpecifier;
          specHoles.push([spec.getStart(sf) - start, spec.getEnd() - start]);
          const typeOnly = ts.isImportDeclaration(n)
            ? n.importClause?.isTypeOnly === true
            : n.isTypeOnly;
          if (ts.isStringLiteral(spec) && !typeOnly) {
            const from = resolveSpec(file, spec.text);
            if (from !== null) refs.add(`${from}#\0${INIT}`); // loading a module runs its own code
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(root);
      const blank = (t: string, holes: [number, number][], fill: boolean): string => {
        for (const [a, b] of [...holes].sort((x, y) => y[0] - x[0]))
          t = t.slice(0, a) + (fill ? " ".repeat(b - a) : "") + t.slice(b);
        return t;
      };
      named(blank(own, [...cutHoles, ...specHoles], true), dirname(join(ROOT, file)), files, dirs);
      // The node's own tokens, without the pieces that are their own nodes: a change shows in the one node it's in, and
      // whitespace and comments, which run nothing, don't count. What reads a file's text as data reaches it by its path.
      hashed += `\0${leaves(root, sf, cut)}`;
    }
    nodes.set(name, { name, hash: sha(hashed), refs, files, dirs });
  }
  // Whatever runs a define function, or the steps, whole runs every unit or step in it: a job prunes the ones it doesn't run.
  for (const [whole, prefix] of [
    [DEFINE, "unit:"],
    [STEPS, "step:"],
  ] as const) {
    const w = nodes.get(whole);
    if (w !== undefined)
      for (const n of nodes.keys()) if (n.startsWith(prefix)) w.refs.add(`${file}#${n}`);
  }
  return { file, nodes, exports, starFrom, spans };
}

/** The node a character offset of a module is in: the innermost piece that holds it, or the module's own code. */
export function nodeAt(m: ModuleInfo, offset: number): string {
  let best: { name: string; start: number; end: number } | null = null;
  for (const s of m.spans)
    if (
      s.start <= offset &&
      offset < s.end &&
      (best === null || s.end - s.start < best.end - best.start)
    )
      best = s;
  return best?.name ?? INIT;
}

/**
 * The roots and the pruning for one gate job's process, `tmk job <milestone> <unit>`: tmk.ts's own code and its job command,
 * everything the modules it loads run when loaded, its milestone's define function and its unit (or the quick tier's step).
 * Not followed: tmk.ts's other commands, other milestones' define functions (the registry's table of them; loadDef runs one),
 * and the other units of its own milestone, which it registers and never runs.
 */
export function jobRoots(
  milestone: string,
  unit: string,
): { roots: string[]; prune: (n: string) => boolean } {
  const own = milestone === "test" ? "tools/quick.ts" : `tools/milestones/${milestone}.ts`;
  const roots = ["tools/tmk.ts#(init)", "tools/tmk.ts#cmdJob"];
  if (milestone === "test")
    roots.push(`${own}#defineQuick`, `${own}#${STEPS}`, `${own}#step:${unit}`);
  else roots.push(`${own}#${DEFINE}`, `${own}#unit:${unit}`);
  const prune = (n: string): boolean => {
    if (n === "tools/tmk.ts#main") return true;
    const m = /^(tools\/milestones\/[\w-]+\.ts|tools\/quick\.ts)#(?:\0)?(.*)$/.exec(n);
    if (m === null) return false;
    const [, f, name] = m as unknown as [string, string, string];
    if (f !== own)
      return (
        name === DEFINE || name.startsWith("define") || name === STEPS || /^unit:|^step:/.test(name)
      );
    if (milestone === "test") return name.startsWith("step:") && name !== `step:${unit}`;
    return name.startsWith("unit:") && name !== `unit:${unit}`;
  };
  return { roots, prune };
}

/**
 * Is this condition true only in the process whose script is this module? `import.meta.main` (in a conjunction), the URL or
 * path of argv[1] being this module's, argv[1] ending with a name no other tools/ module's path ends with, or a disjunction of
 * such conditions.
 */
function entryOnly(e: ts.Expression, file: string): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return entryOnly(e.left, file) || entryOnly(e.right, file);
    if (op === ts.SyntaxKind.BarBarToken)
      return entryOnly(e.left, file) && entryOnly(e.right, file);
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const t = e.getText();
      return /import\.meta\.url/.test(t) && /process\.argv\[1\]/.test(t);
    }
    return false;
  }
  const t = e.getText();
  if (t === "import.meta.main") return true;
  const m = /^process\.argv\[1\]\?\.endsWith\("([\w.-]+)"\)(?: === true)?$/.exec(t);
  if (m !== null) {
    const suffix = m[1]!;
    if (!file.endsWith(`/${suffix}`) && file !== suffix) return false;
    return !otherToolsEndingWith(suffix, file);
  }
  return false;
}

/** An `if` whose every branch is taken only by this module run as a script, with no final `else`. */
function entryChain(s: ts.IfStatement, file: string): boolean {
  if (!entryOnly(s.expression, file)) return false;
  if (s.elseStatement === undefined) return true;
  return ts.isIfStatement(s.elseStatement) && entryChain(s.elseStatement, file);
}

function otherToolsEndingWith(suffix: string, file: string): boolean {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(d, n.name));
      else out.push(join(d, n.name));
    }
  };
  walk("tools");
  return out.some((f) => f !== file && f.endsWith(suffix));
}

/** A piece of source as its tokens alone, from the parse (so a template's parts are its own), skipping cut pieces. */
function leaves(root: ts.Node, sf: ts.SourceFile, cut: Set<ts.Node>): string {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    // A unit's or step's own piece is its own node's; adding or removing one leaves the rest as it was.
    if (n !== root && cut.has(n)) return;
    // Comments run nothing (JSDoc is a child in the parse).
    if (ts.isJSDoc(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) out.push(n.getText(sf));
    else for (const k of kids) visit(k);
  };
  visit(root);
  return out.join("\u0001");
}

/** Does declaring this class run code: a static initialiser or block, a decorator, or a computed base or member name? */
function classRuns(c: ts.ClassDeclaration): boolean {
  if ((ts.getDecorators(c) ?? []).length > 0) return true;
  for (const h of c.heritageClauses ?? [])
    if (
      h.token === ts.SyntaxKind.ExtendsKeyword &&
      h.types.some((t) => !ts.isIdentifier(t.expression))
    )
      return true;
  return c.members.some(
    (m) =>
      ts.isClassStaticBlockDeclaration(m) ||
      (m.name !== undefined && ts.isComputedPropertyName(m.name)) ||
      (ts.getDecorators(m as ts.HasDecorators) ?? []).length > 0 ||
      (ts.isPropertyDeclaration(m) &&
        (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.StaticKeyword) &&
        !inert(m.initializer)),
  );
}

/** A step's construction: an object of plain values and functions, or helpers called with such arguments. */
function constructionPlain(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  if (ts.isObjectLiteralExpression(e))
    return e.properties.every(
      (p) =>
        ts.isMethodDeclaration(p) ||
        (ts.isPropertyAssignment(p) &&
          !ts.isComputedPropertyName(p.name) &&
          constructionPlain(p.initializer)),
    );
  if (ts.isArrayLiteralExpression(e))
    return e.elements.every((x) => !ts.isSpreadElement(x) && constructionPlain(x));
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression))
    return e.arguments.every((a) => !ts.isSpreadElement(a) && constructionPlain(a));
  return inert(e);
}

/** The identifiers a construction reads, outside the functions in it. */
function constructionNames(e: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (!(p !== undefined && ts.isPropertyAssignment(p) && p.name === n)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return out;
}

/** The unit id of an `M.unit("id", ...)` expression statement, or null. */
function unitIdOf(st: ts.Statement): string | null {
  if (!ts.isExpressionStatement(st)) return null;
  const e = st.expression;
  if (!ts.isCallExpression(e)) return null;
  const c = e.expression;
  if (!ts.isPropertyAccessExpression(c) || c.name.text !== "unit") return null;
  const a = e.arguments[0];
  return a !== undefined && ts.isStringLiteralLike(a) ? a.text : null;
}

/** The node an export of a module is, or its whole. A module's own code always comes with it. */
export function resolveExport(file: string, name: string, seen = new Set<string>()): string[] {
  const m = moduleInfo(file);
  if (m === null) return [`${file}#${WHOLE}`];
  const key = `${file}\0${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const out = [`${file}#${INIT}`];
  if (name === WHOLE) return [`${file}#${WHOLE}`];
  if (name === INIT) return out;
  const e = m.exports.get(name);
  if (typeof e === "string") return [...out, `${file}#${e}`];
  if (e !== undefined) return [...out, ...resolveExport(e.from, e.name, seen)];
  // Through `export *`, or a name the module doesn't have (a type, or a mistake): the whole of what it re-exports, then itself.
  const fromStars = m.starFrom.flatMap((f) => {
    const t = moduleInfo(f);
    return t === null ? [`${f}#${WHOLE}`] : resolveExport(f, name, seen);
  });
  if (m.starFrom.length > 0) return [...out, ...fromStars];
  return [`${file}#${WHOLE}`];
}

export interface FineDeps {
  /** Nodes of tools/ modules, "file#name"; a module whose whole is reached is in `wholeFiles`. */
  nodes: Set<string>;
  /** Files reached whole: by path, outside tools/, or a tools/ module that couldn't be narrowed. */
  files: Set<string>;
  dirs: Set<string>;
}

/**
 * Every node and file reachable from these roots. `prune` says which edges not to follow: the registry's table of every
 * milestone's define function, which a job only ever calls for its own milestone.
 */
export function reach(
  roots: string[],
  closureOf: (files: string[]) => { files: Set<string>; dirs: Set<string> },
  prune: (node: string) => boolean = () => false,
  parent?: Map<string, string>,
): FineDeps {
  const nodes = new Set<string>();
  const wholeEntries = new Set<string>();
  const dirs = new Set<string>();
  const todo = [...roots];
  while (todo.length > 0) {
    let id = todo.pop()!;
    if (id.includes("#\0")) {
      const [f, n] = id.split("#\0") as [string, string];
      for (const r of resolveExport(f, n))
        if (!prune(r)) {
          if (parent !== undefined && !parent.has(r)) parent.set(r, parent.get(id) ?? id);
          todo.push(r);
        }
      continue;
    }
    if (nodes.has(id)) continue;
    const hash = id.lastIndexOf("#");
    const file = id.slice(0, hash);
    const name = id.slice(hash + 1);
    const m = moduleInfo(file);
    if (m === null || name === WHOLE) {
      // Reached whole: through the file graph, as before.
      nodes.add(id);
      if (m !== null)
        for (const n of m.nodes.keys())
          if (!prune(`${file}#${n}`)) todo.push(`${file}#${n}`);
          else wholeEntries.add(file);
      continue;
    }
    nodes.add(id);
    const node = m.nodes.get(name);
    if (node === undefined) continue;
    for (const r of node.refs)
      if (!prune(r)) {
        if (parent !== undefined && !parent.has(r) && r !== id && !roots.includes(r))
          parent.set(r, id);
        todo.push(r);
      }
    // Named by its path: a script a child or a worker runs, whole; or data read whole.
    for (const f of node.files) wholeEntries.add(f);
    for (const d of node.dirs) dirs.add(d);
    if (parent !== undefined && !parent.has(`${file}#${INIT}`)) parent.set(`${file}#${INIT}`, id);
    todo.push(`${file}#${INIT}`);
  }
  const c = closureOf([...wholeEntries]);
  for (const d of c.dirs) dirs.add(d);
  return { nodes, files: c.files, dirs };
}

/** Every node's hash, by file: what the baseline keeps, so a change can be told apart node by node. */
export function nodeHashes(files: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of files) {
    if (!analysable(f)) continue;
    const m = moduleInfo(f);
    if (m === null) continue;
    out[f] = Object.fromEntries([...m.nodes].map(([n, x]) => [n, x.hash]));
  }
  return out;
}

/** For tests: forget what's been parsed. */
export function resetDeps(): void {
  modMemo.clear();
}
