// Handles and the moves that consume them (SPEC 3.5, D63). A type alias tagged `@tsl.handle` is a handle type, as
// @tsl/gc's `Counted<T>` is. A `@tsl.moves` parameter of a handle type doesn't copy an object into place, as one of a class
// type does (TSL3006): it takes the caller's handle over. So when its argument is a local, the local is consumed there, and
// reading it again on any path before it's assigned is TSL3009. This is the check that makes `rc.drop(h); h.x` and
// `o.f = rc.take(h); rc.drop(h)` compile errors. It is a may-analysis over the function's statements: a local consumed on
// some path into a read is an error at that read, as a value used after a move is in Rust.
//
// It's about what the program says, not memory safety, which the generation on every counted reference already gives: a
// copy of a handle made some other way is stale once its object goes, and traps with code 5.
import ts from "typescript";
import type { DiagSink } from "./diag.ts";

function leadingDoc(node: ts.Node): string {
  const sf = node.getSourceFile();
  return sf.text.slice(node.getFullStart(), node.getStart(sf));
}

/** Whether a parameter's declared type is a handle type: a reference to an alias tagged `@tsl.handle`. */
export function isHandleParam(checker: ts.TypeChecker, p: ts.ParameterDeclaration): boolean {
  const t = p.type;
  if (t === undefined || !ts.isTypeReferenceNode(t)) return false;
  let sym = checker.getSymbolAtLocation(t.typeName);
  if (sym === undefined) return false;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return (sym.declarations ?? []).some(
    (d) => ts.isTypeAliasDeclaration(d) && /@tsl\.handle\b/.test(leadingDoc(d)),
  );
}

/** The parameter indexes a callee consumes: `@tsl.moves` on a parameter of a handle type. */
function consumedParams(checker: ts.TypeChecker, decl: ts.SignatureDeclaration): number[] {
  const doc = leadingDoc(decl);
  const out: number[] = [];
  for (const m of doc.matchAll(/@tsl\.moves\s+(\w+)/g)) {
    const i = decl.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === m[1]);
    if (i >= 0 && isHandleParam(checker, decl.parameters[i]!)) out.push(i);
  }
  return out;
}

type State = Map<ts.Symbol, string> | null; // consumed locals, each with where; null: unreachable

function join(a: State, b: State): State {
  if (a === null) return b === null ? null : new Map(b);
  if (b === null) return new Map(a);
  const out = new Map(a);
  for (const [k, v] of b) if (!out.has(k)) out.set(k, v);
  return out;
}

function same(a: State, b: State): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}

interface Target {
  label: string | null;
  loop: boolean;
  brk: State;
  cont: State;
}

class Consumes {
  checker: ts.TypeChecker;
  sink: DiagSink;
  sf: ts.SourceFile;
  targets: Target[] = [];
  locals = new Set<ts.Symbol>(); // what this function declares: only these can be consumed
  cache = new Map<ts.Node, number[]>();

  constructor(checker: ts.TypeChecker, sink: DiagSink, sf: ts.SourceFile) {
    this.checker = checker;
    this.sink = sink;
    this.sf = sf;
  }

  symOf(id: ts.Identifier): ts.Symbol | undefined {
    return this.checker.getSymbolAtLocation(id);
  }

  where(n: ts.Node): string {
    const p = this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf));
    return `${p.line + 1}:${p.character + 1}`;
  }

  consumedBy(call: ts.CallExpression): number[] {
    const had = this.cache.get(call);
    if (had !== undefined) return had;
    const decl = this.checker.getResolvedSignature(call)?.declaration;
    const out =
      decl !== undefined && !ts.isJSDocSignature(decl) ? consumedParams(this.checker, decl) : [];
    this.cache.set(call, out);
    return out;
  }

  fn(body: ts.Node, params: readonly ts.ParameterDeclaration[]): void {
    const wasLocals = this.locals;
    const wasTargets = this.targets;
    this.locals = new Set();
    this.targets = [];
    for (const p of params) this.declareName(p.name);
    if (ts.isBlock(body)) this.stmts(body.statements, new Map());
    else this.expr(body as ts.Expression, new Map());
    this.locals = wasLocals;
    this.targets = wasTargets;
  }

  declareName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      const s = this.symOf(name);
      if (s !== undefined) this.locals.add(s);
      return;
    }
    for (const e of name.elements) if (!ts.isOmittedExpression(e)) this.declareName(e.name);
  }

  revive(name: ts.BindingName, s: State): void {
    if (s === null) return;
    if (ts.isIdentifier(name)) {
      const sym = this.symOf(name);
      if (sym !== undefined) s.delete(sym);
      return;
    }
    for (const e of name.elements) if (!ts.isOmittedExpression(e)) this.revive(e.name, s);
  }

  read(id: ts.Identifier, s: State): void {
    if (s === null) return;
    const sym = this.symOf(id);
    if (sym === undefined) return;
    const at = s.get(sym);
    if (at === undefined) return;
    this.sink.at(
      this.sf,
      id,
      "TSL3009",
      `${id.text} was moved at ${at}, and is read here before it's assigned again: share it first if both need it`,
    );
    s.delete(sym); // one error a move
  }

  stmts(list: readonly ts.Statement[], s: State): State {
    for (const st of list) s = this.stmt(st, s);
    return s;
  }

  loop(
    label: string | null,
    s: State,
    once: (s: State) => State,
    tail?: (s: State) => State,
  ): State {
    // Round until what reaches the head settles: a local consumed late in the body is consumed at the top next time.
    let head = s;
    let exit: State = null;
    for (let round = 0; round < 4; round++) {
      const t: Target = { label, loop: true, brk: null, cont: null };
      this.targets.push(t);
      const end = once(head === null ? null : new Map(head));
      this.targets.pop();
      let back = join(end, t.cont);
      if (tail !== undefined) back = tail(back);
      exit = t.brk;
      const next = join(head, back);
      if (same(next, head)) {
        exit = join(exit, head);
        break;
      }
      head = next;
      exit = join(exit, head);
    }
    return exit;
  }

  stmt(st: ts.Statement, s: State): State {
    if (ts.isBlock(st)) return this.stmts(st.statements, s);
    if (ts.isExpressionStatement(st)) return this.expr(st.expression, s);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (d.initializer !== undefined) s = this.expr(d.initializer, s);
        this.declareName(d.name);
        this.revive(d.name, s);
      }
      return s;
    }
    if (ts.isIfStatement(st)) {
      const c = this.expr(st.expression, s);
      const a = this.stmt(st.thenStatement, c === null ? null : new Map(c));
      const b =
        st.elseStatement !== undefined
          ? this.stmt(st.elseStatement, c === null ? null : new Map(c))
          : c;
      return join(a, b);
    }
    if (ts.isReturnStatement(st)) {
      if (st.expression !== undefined) this.expr(st.expression, s);
      return null;
    }
    if (ts.isThrowStatement(st)) {
      this.expr(st.expression, s);
      return null;
    }
    const label = ts.isLabeledStatement(st.parent) ? st.parent.label.text : null;
    if (ts.isLabeledStatement(st)) {
      const inner = st.statement;
      if (ts.isIterationStatement(inner, false)) return this.stmt(inner, s);
      const t: Target = { label: st.label.text, loop: false, brk: null, cont: null };
      this.targets.push(t);
      const end = this.stmt(inner, s);
      this.targets.pop();
      return join(end, t.brk);
    }
    if (ts.isBreakStatement(st) || ts.isContinueStatement(st)) {
      const want = st.label?.text ?? null;
      const brk = ts.isBreakStatement(st);
      for (let i = this.targets.length - 1; i >= 0; i--) {
        const t = this.targets[i]!;
        const hit =
          want !== null ? t.label === want : brk ? t.loop || t.label === "\0switch" : t.loop;
        if (!hit) continue;
        if (brk) t.brk = join(t.brk, s);
        else t.cont = join(t.cont, s);
        break;
      }
      return null;
    }
    if (ts.isWhileStatement(st)) {
      return this.loop(label, s, (h) => {
        const c = this.expr(st.expression, h);
        const t = this.targets[this.targets.length - 1]!;
        t.brk = join(t.brk, c);
        return this.stmt(st.statement, c === null ? null : new Map(c));
      });
    }
    if (ts.isDoStatement(st)) {
      return this.loop(
        label,
        s,
        (h) => this.stmt(st.statement, h),
        (b) => this.expr(st.expression, b),
      );
    }
    if (ts.isForStatement(st)) {
      const init = st.initializer;
      if (init !== undefined) {
        if (ts.isVariableDeclarationList(init)) {
          for (const d of init.declarations) {
            if (d.initializer !== undefined) s = this.expr(d.initializer, s);
            this.declareName(d.name);
            this.revive(d.name, s);
          }
        } else s = this.expr(init, s);
      }
      return this.loop(
        label,
        s,
        (h) => {
          const c = st.condition !== undefined ? this.expr(st.condition, h) : h;
          const t = this.targets[this.targets.length - 1]!;
          if (st.condition !== undefined) t.brk = join(t.brk, c);
          return this.stmt(st.statement, c === null ? null : new Map(c));
        },
        (b) => (st.incrementor !== undefined ? this.expr(st.incrementor, b) : b),
      );
    }
    if (ts.isForOfStatement(st) || ts.isForInStatement(st)) {
      s = this.expr(st.expression, s);
      return this.loop(label, s, (h) => {
        const t = this.targets[this.targets.length - 1]!;
        t.brk = join(t.brk, h);
        const init = st.initializer;
        if (ts.isVariableDeclarationList(init)) {
          for (const d of init.declarations) {
            this.declareName(d.name);
            this.revive(d.name, h);
          }
        } else h = this.assignTo(init, h);
        return this.stmt(st.statement, h);
      });
    }
    if (ts.isSwitchStatement(st)) {
      const v = this.expr(st.expression, s);
      const t: Target = { label: "\0switch", loop: false, brk: null, cont: null };
      this.targets.push(t);
      let fall: State = null;
      let sawDefault = false;
      for (const c of st.caseBlock.clauses) {
        let at = join(fall, v);
        if (ts.isCaseClause(c)) at = this.expr(c.expression, at);
        else sawDefault = true;
        fall = this.stmts(c.statements, at);
      }
      this.targets.pop();
      return join(join(fall, t.brk), sawDefault ? null : v);
    }
    if (ts.isTryStatement(st)) {
      const tried = this.stmt(st.tryBlock, s === null ? null : new Map(s));
      // A catch can start anywhere in the try: from what it started with, or anything it reached.
      let after = tried;
      if (st.catchClause !== undefined) {
        const from = join(s, tried);
        const d = st.catchClause.variableDeclaration;
        if (d !== undefined) this.declareName(d.name);
        after = join(after, this.stmt(st.catchClause.block, from));
      }
      if (st.finallyBlock !== undefined) {
        const f = this.stmt(st.finallyBlock, join(join(s, tried), after));
        return after === null ? null : f;
      }
      return after;
    }
    if (ts.isFunctionDeclaration(st)) {
      if (st.body !== undefined) this.fn(st.body, st.parameters);
      return s;
    }
    if (ts.isClassDeclaration(st)) {
      this.classBody(st);
      return s;
    }
    // Anything else has no expressions this check cares about, or none TSL allows.
    return s;
  }

  classBody(c: ts.ClassLikeDeclaration): void {
    for (const m of c.members) {
      if (
        (ts.isMethodDeclaration(m) ||
          ts.isConstructorDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)) &&
        m.body !== undefined
      )
        this.fn(m.body, m.parameters);
      else if (ts.isPropertyDeclaration(m) && m.initializer !== undefined)
        this.fn(m.initializer, []);
    }
  }

  /** An assignment's target: a local is assigned, and live again; anything else is evaluated as a read. */
  assignTo(target: ts.Expression, s: State): State {
    const t = skipParens(target);
    if (ts.isIdentifier(t)) {
      const sym = this.symOf(t);
      if (s !== null && sym !== undefined) s.delete(sym);
      return s;
    }
    if (ts.isArrayLiteralExpression(t)) {
      for (const e of t.elements) s = this.assignTo(ts.isSpreadElement(e) ? e.expression : e, s);
      return s;
    }
    if (ts.isObjectLiteralExpression(t)) {
      for (const p of t.properties) {
        if (ts.isShorthandPropertyAssignment(p)) s = this.assignTo(p.name, s);
        else if (ts.isPropertyAssignment(p)) s = this.assignTo(p.initializer, s);
      }
      return s;
    }
    return this.expr(t, s);
  }

  expr(e: ts.Expression, s: State): State {
    if (s === null) {
      // Unreachable: nothing to report, but nested functions still get their own check.
      this.nested(e);
      return null;
    }
    if (ts.isIdentifier(e)) {
      this.read(e, s);
      return s;
    }
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e)
    )
      return this.expr(e.expression, s);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) {
        const l = skipParens(e.left);
        if (
          !ts.isIdentifier(l) &&
          !ts.isArrayLiteralExpression(l) &&
          !ts.isObjectLiteralExpression(l)
        )
          s = this.lhsParts(l, s);
        s = this.expr(e.right, s);
        return this.assignTo(e.left, s);
      }
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const l = this.expr(e.left, s);
        const r = this.expr(e.right, l === null ? null : new Map(l));
        return join(l, r);
      }
      if (
        op >= ts.SyntaxKind.FirstCompoundAssignment &&
        op <= ts.SyntaxKind.LastCompoundAssignment
      ) {
        s = this.expr(e.left, s);
        s = this.expr(e.right, s);
        return this.assignTo(e.left, s);
      }
      s = this.expr(e.left, s);
      return this.expr(e.right, s);
    }
    if (ts.isConditionalExpression(e)) {
      const c = this.expr(e.condition, s);
      const a = this.expr(e.whenTrue, c === null ? null : new Map(c));
      const b = this.expr(e.whenFalse, c === null ? null : new Map(c));
      return join(a, b);
    }
    if (ts.isCallExpression(e)) {
      s = this.expr(e.expression, s);
      for (const a of e.arguments) s = this.expr(a, s);
      if (s === null) return s;
      for (const i of this.consumedBy(e)) {
        const a = e.arguments[i];
        if (a === undefined) continue;
        const id = skipParens(a);
        if (!ts.isIdentifier(id)) continue;
        const sym = this.symOf(id);
        if (sym !== undefined && this.locals.has(sym)) s.set(sym, this.where(id));
      }
      return s;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      // Reads inside see what was consumed when it was made; what it consumes of its own stays its own.
      this.captures(e.body, s);
      this.fn(e.body, e.parameters);
      return s;
    }
    if (ts.isClassExpression(e)) {
      this.classBody(e);
      return s;
    }
    let out: State = s;
    ts.forEachChild(e, (c) => {
      if (ts.isExpression(c)) out = this.expr(c, out);
      else if (
        ts.isSpreadAssignment(c) ||
        ts.isPropertyAssignment(c) ||
        ts.isShorthandPropertyAssignment(c)
      ) {
        if (ts.isPropertyAssignment(c)) out = this.expr(c.initializer, out);
        else if (ts.isShorthandPropertyAssignment(c)) out = this.expr(c.name, out);
        else out = this.expr(c.expression, out);
      } else if (ts.isTemplateSpan(c)) out = this.expr(c.expression, out);
    });
    if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
      const op = e.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken)
        out = this.assignTo(e.operand, out);
    }
    return out;
  }

  /** The parts of an assignment's target that are evaluated: `a.b.c = …` reads `a.b`, `a[i] = …` reads `a` and `i`. */
  lhsParts(l: ts.Expression, s: State): State {
    if (ts.isPropertyAccessExpression(l)) return this.expr(l.expression, s);
    if (ts.isElementAccessExpression(l))
      return this.expr(l.argumentExpression, this.expr(l.expression, s));
    return this.expr(l, s);
  }

  captures(body: ts.Node, s: State): void {
    if (s === null || s.size === 0) return;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) this.read(n, s);
      ts.forEachChild(n, visit);
    };
    visit(body);
  }

  nested(e: ts.Node): void {
    const visit = (n: ts.Node): void => {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        this.fn(n.body, n.parameters);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
  }
}

function skipParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** TSL3009 over each module's functions, methods and top-level statements. */
export function checkConsumes(program: ts.Program, modules: ts.SourceFile[], sink: DiagSink): void {
  const checker = program.getTypeChecker();
  for (const sf of modules) {
    const c = new Consumes(checker, sink, sf);
    c.stmts(sf.statements, new Map());
  }
}
