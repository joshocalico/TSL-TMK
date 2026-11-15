// The semantic half of the TSL checker. It computes expression types by the rules of SPEC 3.3
// (tsc only sees `number`), infers `let` types within a function, monomorphises generics, and
// builds the typed tree that TIR lowering and --emit=js-checked both read.
import ts from "typescript";
import type { DiagSink } from "./diag.ts";
import { packageMemory, repoRelative } from "./program.ts";
import {
  elemSize,
  ELEM_BY_ARRAY,
  elemTy,
  INT_RANGE,
  intJoin,
  intWidens,
  leaves,
  makeUnion,
  T,
  tyKey,
  tyName,
  TRAP_NAMES,
  type ElemName,
  type Field,
  type FuncInst,
  type GlobalDef,
  type IntName,
  type Stmt,
  type TE,
  type TEK,
  type Ty,
  type TypedModule,
  type Var,
  type Variant,
} from "./types.ts";

// One inference class: lets and consts whose types must end up equal.
interface Cls {
  parent: Cls | null;
  ev: Ty | null;
  weak: boolean; // used as an index, which is evidence for usize only if nothing else says otherwise
  conflict: boolean;
}

function find(c: Cls): Cls {
  let cur = c;
  for (let guard = 0; cur.parent !== null && guard < 4096; guard++) cur = cur.parent;
  return cur;
}

type TopEntry =
  | { kind: "const"; value: number | bigint } // an untyped constant, which adapts like a literal
  | { kind: "typed"; ty: Ty; value: number | bigint | boolean | string } // an annotated constant
  | { kind: "global"; def: GlobalDef }
  | { kind: "func"; decl: FnDecl };

type FnDecl = ts.FunctionDeclaration | ts.ArrowFunction;

type Env = Map<ts.Symbol, Ty>;

const INT_NAMES = new Set(["i8", "i16", "i32", "u8", "u16", "u32", "usize"]);
const CONVERSIONS: Record<string, Ty> = {
  toI8: T.i8,
  toI16: T.i16,
  toI32: T.i32,
  toU8: T.u8,
  toU16: T.u16,
  toU32: T.u32,
  toUsize: T.usize,
  toU64: T.u64,
  toI64: T.i64,
  toF64: T.f64,
  wrapI8: T.i8,
  wrapI16: T.i16,
  wrapI32: T.i32,
  wrapU8: T.u8,
  wrapU16: T.u16,
  wrapU32: T.u32,
};

function known(t: Ty): boolean {
  return t.k !== "unk" && t.k !== "lit-num" && t.k !== "lit-big";
}
function isLitTy(t: Ty): boolean {
  return t.k === "lit-num" || t.k === "lit-big";
}
function isNumericTy(t: Ty): boolean {
  return t.k === "int" || t.k === "float" || t.k === "big";
}
function stripParens(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let guard = 0; guard < 256; guard++) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else break;
  }
  return cur;
}

function joinNumeric(a: Ty, b: Ty): Ty | null {
  if (a.k === "int" && b.k === "int") {
    const j = intJoin(a.name, b.name);
    return j === null ? null : T[j];
  }
  if (a.k === "float" && b.k === "float")
    return a.name === "f32" && b.name === "f32" ? T.f32 : T.f64;
  if (a.k === "big" && b.k === "big") return a.name === b.name ? a : null;
  return tyKey(a) === tyKey(b) ? a : null;
}

function mk(ty: Ty, node: TEK, deps?: unknown[]): TE {
  const te = { ty, ...node } as TE;
  if (deps !== undefined && deps.length > 0) te.deps = deps;
  return te;
}

export class Elaborator {
  program: ts.Program;
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  sink: DiagSink;
  file: string;
  strings = new Map<string, number>();
  top = new Map<ts.Symbol, TopEntry>();
  enums = new Map<ts.Symbol, Ty>();
  globals: GlobalDef[] = [];
  funcs: FuncInst[] = [];
  instances = new Map<string, FuncInst>();
  instanceCounts = new Map<FnDecl, number>();
  queue: { inst: FuncInst; decl: FnDecl; env: Env }[] = [];
  exportedNames = new Set<string>();
  aliasStack: ts.Symbol[] = [];
  foldMemo = new Map<ts.Node, number | bigint | null>();

  // Per-function state.
  env: Env = new Map();
  scope = new Map<ts.Symbol, Var | { value: number | bigint }>();
  infer = new Map<ts.Symbol, Cls>();
  inferByVar = new Map<Var, Cls>();
  finalTy = new Map<ts.Symbol, Ty>();
  dry = false;
  changed = false;
  retTy: Ty = T.void;
  nextVar = 1;
  nextHidden = 1;

  constructor(program: ts.Program, sf: ts.SourceFile, sink: DiagSink) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.sf = sf;
    this.sink = sink;
    this.file = repoRelative(sf.fileName);
    this.internStrings();
  }

  err(node: ts.Node, code: string, msg: string): TE {
    this.sink.at(this.sf, node, code, msg);
    return mk(T.unk, { k: "err" });
  }

  loc(node: ts.Node): string {
    const p = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    return `${this.file}:${p.line + 1}:${p.character + 1}`;
  }

  /** Literal-union and tag text compiles to small integers, numbered in code-unit order. */
  internStrings(): void {
    const seen = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isStringLiteral(n)) seen.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(this.sf);
    [...seen].sort().forEach((s, i) => this.strings.set(s, i + 1));
  }

  symbolOf(node: ts.Node): ts.Symbol | undefined {
    const sym = this.checker.getSymbolAtLocation(node);
    if (sym === undefined) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
  }

  isCoreSymbol(sym: ts.Symbol): boolean {
    const decl = sym.declarations?.[0];
    return (
      decl !== undefined && decl.getSourceFile().fileName.endsWith("packages/tsl-core/index.ts")
    );
  }

  /**
   * An enum, this module's or one it imports, and @tsl/core's `Trap` (3.10), a constant object of numbers and a type of the
   * same name, which is a numeric enum to TSL: its members are constants.
   */
  enumOf(sym: ts.Symbol): Ty | undefined {
    const known = this.enums.get(sym);
    if (known !== undefined) return known;
    const decls = sym.declarations ?? [];
    const decl = decls[0];
    if (decl === undefined || decl.getSourceFile() === this.sf) return undefined;
    if (ts.isEnumDeclaration(decl)) {
      this.declareEnum(decl);
      return this.enums.get(sym);
    }
    if (!this.isCoreSymbol(sym) || sym.name !== "Trap") return undefined;
    for (const d of decls) {
      if (!ts.isVariableDeclaration(d) || d.initializer === undefined) continue;
      const init = d.initializer;
      const obj = ts.isAsExpression(init) ? init.expression : init;
      if (!ts.isObjectLiteralExpression(obj)) continue;
      const members = new Map<string, number>();
      for (const p of obj.properties)
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          ts.isNumericLiteral(p.initializer)
        )
          members.set(p.name.text, Number(p.initializer.text));
      const t: Ty = { k: "enum", name: "Trap", members };
      this.enums.set(sym, t);
      return t;
    }
    return undefined;
  }

  /** A trap code as a `u32`: an enum member is its constant, so `trap(Trap.Bounds)` is `trap(2)`'s tree exactly. */
  trapCode(x: ts.Expression): TE {
    const v = this.expr(x, T.u32);
    if (v.k === "lit" && v.ty.k === "enum") return mk(T.u32, { k: "lit", value: v.value });
    return this.coerce(v, T.u32, x);
  }

  /**
   * TSL1026: a trap code given as a bare number (3.10). A code is named: @tsl/core's `Trap` for 3.10's table, or the
   * program's own enum or constant for a code from 1000. Only a literal is refused, so the enum's own definition is
   * where the numbers are.
   */
  bareTrapCode(x: ts.Expression, what: string): boolean {
    let b = x;
    while (ts.isParenthesizedExpression(b)) b = b.expression;
    if (
      ts.isPrefixUnaryExpression(b) &&
      (b.operator === ts.SyntaxKind.MinusToken || b.operator === ts.SyntaxKind.PlusToken)
    )
      b = b.operand;
    while (ts.isParenthesizedExpression(b)) b = b.expression;
    if (!ts.isNumericLiteral(b)) return false;
    const n = TRAP_NAMES[Number(b.text)];
    this.err(
      x,
      "TSL1026",
      n !== undefined
        ? `${what}'s code is a bare number: name it, @tsl/core's Trap.${n} (3.10)`
        : `${what}'s code is a bare number: name it, with the program's own enum or constant for its codes from 1000 (3.10)`,
    );
    return true;
  }

  isLibSymbol(sym: ts.Symbol): boolean {
    const decl = sym.declarations?.[0];
    return decl !== undefined && this.program.isSourceFileDefaultLibrary(decl.getSourceFile());
  }

  // --- module level

  run(): TypedModule {
    for (const st of this.sf.statements) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) {
          this.exportedNames.add((e.propertyName ?? e.name).text);
        }
      }
    }
    for (const st of this.sf.statements) {
      if (ts.isEnumDeclaration(st)) this.declareEnum(st);
    }
    // Functions hoist, so register them before anything can refer to them.
    for (const st of this.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.body !== undefined) {
        const sym = this.symbolOf(st.name);
        if (sym !== undefined) this.top.set(sym, { kind: "func", decl: st });
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) &&
            d.initializer !== undefined &&
            ts.isArrowFunction(d.initializer)
          ) {
            const sym = this.symbolOf(d.name);
            if (sym !== undefined) this.top.set(sym, { kind: "func", decl: d.initializer });
          }
        }
      }
    }
    for (const st of this.sf.statements) {
      if (ts.isVariableStatement(st)) {
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of st.declarationList.declarations) this.declareTop(d, isConst);
      }
    }
    for (const st of this.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.body !== undefined) {
        if (st.typeParameters === undefined) this.instance(st, [], st);
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const init = d.initializer;
          if (init !== undefined && ts.isArrowFunction(init) && init.typeParameters === undefined) {
            this.instance(init, [], d);
          }
        }
      }
    }
    for (let guard = 0; this.queue.length > 0 && guard < 100000; guard++) {
      const item = this.queue.shift()!;
      this.elabInstance(item.inst, item.decl, item.env);
    }
    return { file: this.file, funcs: this.funcs, globals: this.globals, strings: this.strings };
  }

  declareEnum(e: ts.EnumDeclaration): void {
    const sym = this.symbolOf(e.name);
    if (sym === undefined) return;
    const members = new Map<string, number>();
    for (const m of e.members) {
      const name = m.name.getText(m.getSourceFile());
      const v = m.initializer !== undefined ? this.fold(m.initializer) : null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
        this.err(m, "TSL1011", "enum members need explicit i32 constants");
        continue;
      }
      members.set(name, v);
    }
    this.enums.set(sym, { k: "enum", name: e.name.text, members });
  }

  /** Evaluates a constant expression with JS semantics. Null if it isn't a constant. */
  fold(e: ts.Expression): number | bigint | null {
    if (this.foldMemo.has(e) && !ts.isIdentifier(e)) return this.foldMemo.get(e)!;
    const v = this.foldInner(e);
    this.foldMemo.set(e, v);
    return v;
  }

  foldInner(e: ts.Expression): number | bigint | null {
    if (ts.isParenthesizedExpression(e)) return this.fold(e.expression);
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (e.kind === ts.SyntaxKind.BigIntLiteral) {
      return BigInt((e as ts.BigIntLiteral).text.replace(/n$/, ""));
    }
    if (ts.isIdentifier(e)) {
      if (e.text === "NaN" || e.text === "Infinity") {
        const s = this.symbolOf(e);
        if (s !== undefined && this.isLibSymbol(s)) return e.text === "NaN" ? Number.NaN : Infinity;
      }
      const sym = this.symbolOf(e);
      if (sym === undefined) return null;
      const local = this.scope.get(sym);
      if (local !== undefined) return "value" in local ? local.value : null;
      const t = this.top.get(sym);
      return t?.kind === "const" ? t.value : null;
    }
    if (ts.isPrefixUnaryExpression(e)) {
      const v = this.fold(e.operand);
      if (v === null) return null;
      switch (e.operator) {
        case ts.SyntaxKind.MinusToken:
          return -v;
        case ts.SyntaxKind.PlusToken:
          return typeof v === "number" ? v : null;
        case ts.SyntaxKind.TildeToken:
          return ~v;
        default:
          return null;
      }
    }
    if (ts.isBinaryExpression(e)) {
      const a = this.fold(e.left);
      if (a === null) return null;
      const b = this.fold(e.right);
      if (b === null) return null;
      if (typeof a === "number" && typeof b === "number")
        return foldNumber(e.operatorToken.kind, a, b);
      if (typeof a === "bigint" && typeof b === "bigint")
        return foldBig(e.operatorToken.kind, a, b);
    }
    return null;
  }

  declareTop(d: ts.VariableDeclaration, isConst: boolean): void {
    if (!ts.isIdentifier(d.name)) {
      this.err(d, "TSL9001", "top-level destructuring is not implemented");
      return;
    }
    const sym = this.symbolOf(d.name);
    if (sym === undefined) return;
    const name = d.name.text;
    const init = d.initializer;
    if (init === undefined) {
      this.err(d, "TSL1008", "a top-level binding needs a constant initialiser");
      return;
    }
    if (ts.isArrowFunction(init)) return;

    if (ts.isArrayLiteralExpression(init)) {
      this.declareTable(d, sym, name, init);
      return;
    }
    if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
      const elem = ELEM_BY_ARRAY[init.expression.text];
      if (elem !== undefined) {
        this.declareTypedArray(sym, name, init, elem);
        return;
      }
    }
    if (
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === "lit"
    ) {
      const arg = init.arguments[0];
      if (arg === undefined || !ts.isStringLiteralLike(arg)) {
        this.err(init, "TSL1010", "lit takes a string literal");
        return;
      }
      const bytes = Uint8Array.from(Buffer.from(arg.text, "utf8"));
      const def: GlobalDef = {
        name,
        jsName: name,
        ty: { k: "arr", elem: "u8" },
        mutable: false,
        array: { elem: "u8", length: bytes.length, bytes, text: arg.text },
      };
      this.globals.push(def);
      this.top.set(sym, { kind: "global", def });
      return;
    }

    const annotated = d.type !== undefined ? this.typeOf(d.type) : null;
    if (annotated === null && isConst) {
      const v = this.fold(init);
      if (v !== null) {
        this.top.set(sym, { kind: "const", value: v });
        return;
      }
    }
    if (annotated !== null && (annotated.k === "rec" || annotated.k === "union")) {
      this.err(d, annotated.k === "union" ? "TSL3005" : "TSL9001", "value types can't be globals");
      return;
    }
    let te = this.expr(init, annotated ?? undefined);
    if (annotated !== null) te = this.coerce(te, annotated, init);
    if (te.ty.k === "rec" || te.ty.k === "union") {
      this.err(d, te.ty.k === "union" ? "TSL3005" : "TSL9001", "value types can't be globals");
      return;
    }
    if (te.ty.k === "unk") return;
    const value = this.evalConst(te);
    if (value === null) {
      this.err(init, "TSL1010", "top-level initialisers must be constant");
      return;
    }
    if (isLitTy(te.ty)) {
      this.err(d, "TSL2001", "a top-level let needs a type annotation");
      return;
    }
    if (isConst) {
      this.top.set(sym, { kind: "typed", ty: te.ty, value });
      return;
    }
    const def: GlobalDef = { name, jsName: name, ty: te.ty, mutable: true, value };
    if (packageMemory(d.getSourceFile().fileName) === "manual") def.memory = "manual";
    this.globals.push(def);
    this.top.set(sym, { kind: "global", def });
  }

  declareTable(
    d: ts.VariableDeclaration,
    sym: ts.Symbol,
    name: string,
    init: ts.ArrayLiteralExpression,
  ): void {
    const insts: FuncInst[] = [];
    let elemTyFn: Ty | null = null;
    for (const e of init.elements) {
      const id = stripParens(e);
      const s = ts.isIdentifier(id) ? this.symbolOf(id) : undefined;
      const entry = s !== undefined ? this.top.get(s) : undefined;
      if (entry?.kind !== "func" || entry.decl.typeParameters !== undefined) {
        this.err(e, "TSL1010", "a dispatch table holds non-generic top-level functions");
        return;
      }
      const fnTy = this.fnTyOf(entry.decl);
      if (elemTyFn !== null && tyKey(elemTyFn) !== tyKey(fnTy)) {
        this.err(e, "TSL2006", "a dispatch table's functions must have the same signature");
        return;
      }
      elemTyFn = fnTy;
      insts.push(this.instance(entry.decl, [], e));
    }
    if (elemTyFn === null) {
      this.err(d, "TSL1006", "an empty table has no type");
      return;
    }
    const def: GlobalDef = { name, jsName: name, ty: elemTyFn, mutable: false, table: insts };
    this.globals.push(def);
    this.top.set(sym, { kind: "global", def });
  }

  declareTypedArray(sym: ts.Symbol, name: string, init: ts.NewExpression, elem: ElemName): void {
    const args = init.arguments ?? [];
    const first = args[0];
    if (args.length !== 1 || first === undefined) {
      this.err(init, "TSL1010", "a static typed array takes one length or one array literal");
      return;
    }
    let def: GlobalDef;
    if (ts.isArrayLiteralExpression(first)) {
      const values: (number | bigint)[] = [];
      const target = elem === "f32" ? T.f64 : elemTy(elem);
      for (const e of first.elements) {
        const te = this.coerce(this.expr(e, target), target, e);
        const v = te.ty.k === "unk" ? 0 : this.evalConst(te);
        if (typeof v !== "number" && typeof v !== "bigint") {
          if (te.ty.k !== "unk") this.err(e, "TSL1010", "typed-array elements must be constant");
          values.push(0);
        } else values.push(v);
      }
      def = {
        name,
        jsName: name,
        ty: { k: "arr", elem },
        mutable: false,
        array: { elem, length: values.length, values, bytes: packElems(elem, values) },
      };
    } else {
      const te = this.coerce(this.expr(first, T.usize), T.usize, first);
      if (te.ty.k === "unk") return;
      const n = this.evalConst(te);
      if (typeof n !== "number") {
        this.err(first, "TSL1010", "a static typed array's length must be constant");
        return;
      }
      def = {
        name,
        jsName: name,
        ty: { k: "arr", elem },
        mutable: false,
        array: { elem, length: n },
      };
    }
    this.globals.push(def);
    this.top.set(sym, { kind: "global", def });
  }

  evalConst(te: TE): number | bigint | boolean | string | null {
    switch (te.k) {
      case "lit":
        return te.value;
      case "conv":
        return this.evalConst(te.val);
      case "arith": {
        const a = this.evalConst(te.a);
        const b = this.evalConst(te.b);
        if (typeof a === "number" && typeof b === "number") {
          const op = te.op;
          if (op === "idiv") return b === 0 ? null : Math.trunc(a / b);
          if (op === "rem" && b === 0) return null;
          const v = op === "add" ? a + b : op === "sub" ? a - b : op === "mul" ? a * b : a % b;
          return te.ty.k === "int" && inRange(v, te.ty.name) ? v : te.wrap ? v : null;
        }
        if (typeof a === "bigint" && typeof b === "bigint") {
          const op = te.op;
          if ((op === "rem" || op === "idiv") && b === 0n) return null;
          const v =
            op === "add"
              ? a + b
              : op === "sub"
                ? a - b
                : op === "mul"
                  ? a * b
                  : op === "rem"
                    ? a % b
                    : a / b;
          return v;
        }
        return null;
      }
      case "farith": {
        const a = this.evalConst(te.a);
        const b = this.evalConst(te.b);
        if (typeof a !== "number" || typeof b !== "number") return null;
        return te.op === "add" ? a + b : te.op === "sub" ? a - b : te.op === "mul" ? a * b : a / b;
      }
      case "bit": {
        const a = this.evalConst(te.a);
        const b = this.evalConst(te.b);
        if (typeof a === "number" && typeof b === "number") {
          switch (te.op) {
            case "and":
              return a & b;
            case "or":
              return a | b;
            case "xor":
              return a ^ b;
            case "shl":
              return a << b;
            case "shr":
              return a >> b;
            case "ushr":
              return a >>> b;
          }
        }
        if (typeof a === "bigint" && typeof b === "bigint") {
          if (te.op === "and") return a & b;
          if (te.op === "or") return a | b;
          if (te.op === "xor") return a ^ b;
        }
        return null;
      }
      case "neg": {
        const a = this.evalConst(te.a);
        return typeof a === "number" || typeof a === "bigint" ? -a : null;
      }
      case "bitnot": {
        const a = this.evalConst(te.a);
        return typeof a === "number" ? ~a : typeof a === "bigint" ? ~a : null;
      }
      case "not": {
        const a = this.evalConst(te.a);
        return typeof a === "boolean" ? !a : null;
      }
      default:
        return null;
    }
  }

  // --- types

  typeOf(node: ts.TypeNode, env: Env = this.env): Ty {
    switch (node.kind) {
      case ts.SyntaxKind.BooleanKeyword:
        return T.bool;
      case ts.SyntaxKind.VoidKeyword:
        return T.void;
      case ts.SyntaxKind.NeverKeyword:
        return T.never;
      case ts.SyntaxKind.ParenthesizedType:
        return this.typeOf((node as ts.ParenthesizedTypeNode).type, env);
      case ts.SyntaxKind.LiteralType:
        return this.literalType(node as ts.LiteralTypeNode);
      case ts.SyntaxKind.UnionType:
        return this.unionType(node as ts.UnionTypeNode, env);
      case ts.SyntaxKind.TypeLiteral:
        return this.recordType((node as ts.TypeLiteralNode).members, node, env);
      case ts.SyntaxKind.FunctionType: {
        const f = node as ts.FunctionTypeNode;
        return {
          k: "fn",
          params: f.parameters.map((p) =>
            p.type !== undefined ? this.typeOf(p.type, env) : T.unk,
          ),
          ret: this.typeOf(f.type, env),
        };
      }
      case ts.SyntaxKind.TypeReference:
        return this.typeRef(node as ts.TypeReferenceNode, env);
      default:
        this.err(node, "TSL9001", "this kind of type is not in M1's subset");
        return T.unk;
    }
  }

  literalType(node: ts.LiteralTypeNode): Ty {
    const l = node.literal;
    if (ts.isStringLiteral(l)) return { k: "lits", kind: "str", values: [l.text] };
    if (ts.isNumericLiteral(l)) return { k: "lits", kind: "num", values: [Number(l.text)] };
    if (ts.isPrefixUnaryExpression(l) && ts.isNumericLiteral(l.operand)) {
      return { k: "lits", kind: "num", values: [-Number(l.operand.text)] };
    }
    if (l.kind === ts.SyntaxKind.TrueKeyword || l.kind === ts.SyntaxKind.FalseKeyword)
      return T.bool;
    this.err(node, "TSL9001", "this literal type is not in M1's subset");
    return T.unk;
  }

  unionType(node: ts.UnionTypeNode, env: Env): Ty {
    const parts = node.types.map((t) => this.typeOf(t, env));
    if (parts.some((p) => p.k === "unk")) return T.unk;
    if (parts.every((p) => p.k === "lits")) {
      const kind = (parts[0] as { kind: "str" | "num" }).kind;
      if (parts.some((p) => p.k === "lits" && p.kind !== kind)) {
        this.err(node, "TSL9001", "a literal union is all strings or all numbers");
        return T.unk;
      }
      const values = parts.flatMap((p) => (p.k === "lits" ? p.values : []));
      return { k: "lits", kind, values };
    }
    if (parts.every((p) => p.k === "bool")) return T.bool;
    // A union of record variants: flatten nested unions of variants, then find the tag.
    const records: { fields: Field[]; node: ts.TypeNode }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.k === "rec") records.push({ fields: p.fields, node: node.types[i]! });
      else if (p.k === "union") {
        for (const v of p.variants) {
          const tagTy: Ty =
            typeof v.tag === "boolean"
              ? T.bool
              : { k: "lits", kind: typeof v.tag === "string" ? "str" : "num", values: [v.tag] };
          records.push({
            fields: [{ name: p.tag, ty: tagTy, boolLit: v.tag } as Field, ...v.fields],
            node: node.types[i]!,
          });
        }
      } else {
        this.err(node.types[i]!, "TSL9001", "a union is literals, or records with a shared tag");
        return T.unk;
      }
    }
    return this.buildUnion(node, records);
  }

  buildUnion(node: ts.TypeNode, records: { fields: Field[]; node: ts.TypeNode }[]): Ty {
    const first = records[0]!;
    const candidates = first.fields.filter((f) => {
      return records.every((r) => {
        const g = r.fields.find((x) => x.name === f.name);
        return g !== undefined && (g.ty.k === "lits" || g.ty.k === "bool") && g.ty.k === f.ty.k;
      });
    });
    const tag = candidates.find((c) => this.tagValueFromNode(records, c.name) !== null);
    if (tag === undefined) {
      this.err(node, "TSL3005", "a value union needs one literal-typed field all variants share");
      return T.unk;
    }
    const values = this.tagValueFromNode(records, tag.name)!;
    const parts = records.map((r, i) => ({
      tag: values[i]!,
      fields: r.fields.filter((f) => f.name !== tag.name),
    }));
    const u = makeUnion(tag.name, parts);
    if (leaves(u).length > 4) {
      this.err(node, "TSL3004", "a value union flattens to at most 4 machine words");
      return T.unk;
    }
    return u;
  }

  /** Each variant's tag value, read from its field's literal type, or null if one isn't literal. */
  tagValueFromNode(
    records: { fields: Field[]; node: ts.TypeNode }[],
    name: string,
  ): (boolean | string | number)[] | null {
    const out: (boolean | string | number)[] = [];
    for (const r of records) {
      const f = r.fields.find((x) => x.name === name)!;
      if (f.ty.k === "lits" && f.ty.values.length === 1) {
        out.push(f.ty.values[0]!);
      } else if (f.ty.k === "bool") {
        const v = (f as Field & { boolLit?: boolean }).boolLit;
        if (v === undefined) return null;
        out.push(v);
      } else return null;
    }
    return out;
  }

  recordType(members: readonly ts.TypeElement[], node: ts.Node, env: Env): Ty {
    const fields: (Field & { boolLit?: boolean })[] = [];
    for (const m of members) {
      if (!ts.isPropertySignature(m) || m.type === undefined || !ts.isIdentifier(m.name)) {
        this.err(m, "TSL1005", "a value record has named, typed fields");
        return T.unk;
      }
      if (!m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword)) {
        this.err(m, "TSL1005", "value records are all-readonly");
        return T.unk;
      }
      const ty = this.typeOf(m.type, env);
      if (ty.k === "unk") return T.unk;
      if (ty.k === "union") {
        this.err(m, "TSL3005", "a value union can't be stored in a field");
        return T.unk;
      }
      if (ty.k === "arr" || ty.k === "fn") {
        this.err(
          m,
          "TSL9001",
          "typed arrays and functions in value records are not in M1's subset",
        );
        return T.unk;
      }
      const f: Field & { boolLit?: boolean } = { name: m.name.text, ty };
      if (ts.isLiteralTypeNode(m.type)) {
        if (m.type.literal.kind === ts.SyntaxKind.TrueKeyword) f.boolLit = true;
        if (m.type.literal.kind === ts.SyntaxKind.FalseKeyword) f.boolLit = false;
      }
      fields.push(f);
    }
    const rec: Ty = { k: "rec", fields };
    if (leaves(rec).length > 4) {
      this.err(node, "TSL3004", "a value record flattens to at most 4 machine words");
      return T.unk;
    }
    return rec;
  }

  typeRef(node: ts.TypeReferenceNode, env: Env): Ty {
    const sym = this.symbolOf(node.typeName);
    if (sym === undefined) return T.unk;
    if (sym.flags & ts.SymbolFlags.TypeParameter) {
      return env.get(sym) ?? T.unk;
    }
    const name = sym.name;
    if (this.isLibSymbol(sym)) {
      const elem = ELEM_BY_ARRAY[name];
      if (elem !== undefined) return { k: "arr", elem };
      this.err(node, "TSL1006", `${name} needs a runtime or hidden allocation`);
      return T.unk;
    }
    if (this.isCoreSymbol(sym)) {
      if (INT_NAMES.has(name)) return T[name as IntName];
      if (name === "u64" || name === "i64" || name === "f32" || name === "f64" || name === "bool") {
        return T[name];
      }
      if (name === "Num" || name === "Int" || name === "Big") {
        this.err(node, "TSL9001", `${name} is the flavour machinery, not a type to use directly`);
        return T.unk;
      }
    }
    const en = this.enumOf(sym);
    if (en !== undefined) return en;
    const decl = sym.declarations?.[0];
    if (decl !== undefined && ts.isTypeAliasDeclaration(decl)) {
      if (this.aliasStack.includes(sym)) {
        this.err(node, "TSL3004", "value types are not recursive");
        return T.unk;
      }
      const inner: Env = new Map(env);
      const args = node.typeArguments ?? [];
      decl.typeParameters?.forEach((tp, i) => {
        const p = this.checker.getSymbolAtLocation(tp.name);
        const a = args[i];
        if (p !== undefined && a !== undefined) inner.set(p, this.typeOf(a, env));
      });
      this.aliasStack.push(sym);
      const ty = this.typeOf(decl.type, inner);
      this.aliasStack.pop();
      return ty;
    }
    if (decl !== undefined && ts.isInterfaceDeclaration(decl)) {
      return this.recordType(decl.members, node, env);
    }
    this.err(node, "TSL9001", `the type ${name} is not in M1's subset`);
    return T.unk;
  }

  fnTyOf(decl: FnDecl): Ty {
    return {
      k: "fn",
      params: decl.parameters.map((p) => (p.type !== undefined ? this.typeOf(p.type) : T.unk)),
      ret: decl.type !== undefined ? this.typeOf(decl.type) : T.unk,
    };
  }

  // --- functions

  fnName(decl: FnDecl): string {
    if (ts.isFunctionDeclaration(decl)) return decl.name?.text ?? "anon";
    const p = decl.parent;
    return ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text : "anon";
  }

  isExported(decl: FnDecl, name: string): boolean {
    if (this.exportedNames.has(name)) return true;
    const host = ts.isFunctionDeclaration(decl) ? decl : decl.parent.parent.parent;
    if (!ts.canHaveModifiers(host)) return false;
    return ts.getModifiers(host)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  attrsOf(decl: FnDecl): string[] {
    const host = ts.isFunctionDeclaration(decl) ? decl : decl.parent.parent.parent;
    const text = this.sf.text.slice(host.getFullStart(), host.getStart(this.sf));
    const out: string[] = [];
    for (const a of ["inline", "noalloc", "noinline", "nosleep"]) {
      if (new RegExp(`@tsl\\.${a}\\b`).test(text)) out.push(a);
    }
    return out;
  }

  instance(decl: FnDecl, tyArgs: Ty[], at: ts.Node): FuncInst {
    const name = this.fnName(decl);
    const generic = tyArgs.length > 0;
    const key = generic ? `${name}<${tyArgs.map(tyKey).join(",")}>` : name;
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing;
    if (generic) {
      const n = (this.instanceCounts.get(decl) ?? 0) + 1;
      this.instanceCounts.set(decl, n);
      if (n === 129) this.err(at, "TSL4001", `${name} has more than 128 instantiations`);
    }
    const env: Env = new Map();
    decl.typeParameters?.forEach((tp, i) => {
      const s = this.checker.getSymbolAtLocation(tp.name);
      if (s !== undefined) env.set(s, tyArgs[i] ?? T.unk);
    });
    const params = decl.parameters.map((p): Var => {
      const ty = p.type !== undefined ? this.typeOf(p.type, env) : T.unk;
      const pname = ts.isIdentifier(p.name) ? p.name.text : "p";
      return { id: this.nextVar++, name: pname, ty };
    });
    const exported = !generic && this.isExported(decl, name);
    const attrs = this.attrsOf(decl);
    if (exported) attrs.unshift("export");
    const inst: FuncInst = {
      key,
      tirName: key,
      jsName: generic ? `${name}$${tyArgs.map(tyKey).join("$")}` : name,
      params,
      ret: decl.type !== undefined ? this.typeOf(decl.type, env) : T.unk,
      exported,
      attrs,
      body: [],
    };
    this.instances.set(key, inst);
    this.funcs.push(inst);
    this.queue.push({ inst, decl, env });
    return inst;
  }

  elabInstance(inst: FuncInst, decl: FnDecl, env: Env): void {
    const saved = {
      env: this.env,
      scope: this.scope,
      infer: this.infer,
      inferByVar: this.inferByVar,
      finalTy: this.finalTy,
      dry: this.dry,
      retTy: this.retTy,
    };
    this.env = env;
    this.retTy = inst.ret;
    this.infer = new Map();
    this.inferByVar = new Map();
    this.finalTy = new Map();

    // Dry passes gather evidence for unannotated lets. Monotonic over a finite lattice, so this
    // settles quickly; the cap is the guard, and hitting it reports TSL2001 rather than looping.
    this.dry = true;
    this.sink.muted++;
    let settled = false;
    for (let pass = 0; pass < 8; pass++) {
      this.changed = false;
      this.scope = new Map();
      this.bindParams(inst, decl);
      this.body(decl);
      if (!this.changed) {
        settled = true;
        break;
      }
    }
    this.sink.muted--;
    this.dry = false;

    for (const [sym, cls] of this.infer) {
      const c = find(cls);
      const declNode = sym.valueDeclaration ?? sym.declarations?.[0];
      const at =
        declNode !== undefined ? ((declNode as ts.NamedDeclaration).name ?? declNode) : decl;
      if (!settled || c.conflict) {
        this.err(at, "TSL2001", `conflicting evidence for the type of ${sym.name}: annotate it`);
        this.finalTy.set(sym, T.unk);
      } else if (c.ev !== null) this.finalTy.set(sym, c.ev);
      else if (c.weak) this.finalTy.set(sym, T.usize);
      else {
        this.err(at, "TSL2001", `no evidence for the type of ${sym.name}: annotate it`);
        this.finalTy.set(sym, T.unk);
      }
    }

    this.scope = new Map();
    this.bindParams(inst, decl);
    inst.body = this.body(decl);

    this.env = saved.env;
    this.scope = saved.scope;
    this.infer = saved.infer;
    this.inferByVar = saved.inferByVar;
    this.finalTy = saved.finalTy;
    this.dry = saved.dry;
    this.retTy = saved.retTy;
  }

  bindParams(inst: FuncInst, decl: FnDecl): void {
    decl.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name)) {
        this.err(p, "TSL9001", "destructured parameters are not implemented");
        return;
      }
      const sym = this.symbolOf(p.name);
      if (sym !== undefined) this.scope.set(sym, inst.params[i]!);
    });
  }

  body(decl: FnDecl): Stmt[] {
    const b = decl.body;
    if (b === undefined) return [];
    if (ts.isBlock(b)) return this.block(b.statements);
    // An arrow with an expression body.
    const e = this.coerce(this.expr(b, this.retTy), this.retTy, b);
    return [{ k: "return", val: e }];
  }

  block(sts: readonly ts.Statement[]): Stmt[] {
    const out: Stmt[] = [];
    for (const s of sts) out.push(...this.stmt(s));
    return out;
  }

  // --- statements

  stmt(s: ts.Statement): Stmt[] {
    if (ts.isVariableStatement(s)) return this.varList(s.declarationList);
    if (ts.isExpressionStatement(s)) return [{ k: "expr", e: this.exprStmt(s.expression) }];
    if (ts.isBlock(s)) return [{ k: "block", body: this.block(s.statements) }];
    if (ts.isIfStatement(s)) {
      return [
        {
          k: "if",
          c: this.condition(s.expression),
          a: this.stmt(s.thenStatement),
          b: s.elseStatement !== undefined ? this.stmt(s.elseStatement) : null,
        },
      ];
    }
    if (ts.isWhileStatement(s)) {
      return [{ k: "while", c: this.condition(s.expression), body: this.stmt(s.statement) }];
    }
    if (ts.isDoStatement(s)) {
      const body = this.stmt(s.statement);
      return [{ k: "do", body, c: this.condition(s.expression) }];
    }
    if (ts.isForStatement(s)) return [this.forStmt(s)];
    if (ts.isForOfStatement(s)) return [this.forOf(s)];
    if (ts.isSwitchStatement(s)) return [this.switchStmt(s)];
    if (ts.isLabeledStatement(s)) {
      const inner = this.stmt(s.statement);
      // The label has to sit directly on a loop for `continue label` to mean anything.
      const body: Stmt = inner.length === 1 ? inner[0]! : { k: "block", body: inner };
      return [{ k: "label", name: s.label.text, body }];
    }
    if (ts.isBreakStatement(s)) return [{ k: "break", label: s.label?.text ?? null }];
    if (ts.isContinueStatement(s)) return [{ k: "continue", label: s.label?.text ?? null }];
    if (ts.isReturnStatement(s)) {
      if (s.expression === undefined) return [{ k: "return", val: null }];
      const e = this.coerce(this.expr(s.expression, this.retTy), this.retTy, s.expression);
      return [{ k: "return", val: e }];
    }
    if (ts.isEmptyStatement(s)) return [];
    this.err(s, "TSL9001", "this statement is not in M1's subset");
    return [];
  }

  condition(e: ts.Expression): TE {
    const c = this.expr(e);
    if (c.ty.k !== "bool" && c.ty.k !== "unk") {
      return this.err(e, "TSL2007", `a condition must be bool, not ${tyName(c.ty)}`);
    }
    return c;
  }

  forStmt(s: ts.ForStatement): Stmt {
    const init: Stmt[] = [];
    if (s.initializer !== undefined) {
      if (ts.isVariableDeclarationList(s.initializer)) init.push(...this.varList(s.initializer));
      else init.push({ k: "expr", e: this.exprStmt(s.initializer) });
    }
    const c = s.condition !== undefined ? this.condition(s.condition) : null;
    const step: TE[] = [];
    if (s.incrementor !== undefined) step.push(this.exprStmt(s.incrementor));
    const body = this.stmt(s.statement);
    return { k: "for", init, c, step, body };
  }

  forOf(s: ts.ForOfStatement): Stmt {
    const arr = this.expr(s.expression);
    const init = s.initializer;
    if (arr.ty.k !== "arr") {
      if (arr.ty.k === "unk") return { k: "block", body: [] };
      this.err(s.expression, "TSL1006", "for...of is over typed arrays only");
      return { k: "block", body: [] };
    }
    if (!ts.isVariableDeclarationList(init) || !ts.isIdentifier(init.declarations[0]!.name)) {
      this.err(init, "TSL9001", "for...of declares one variable");
      return { k: "block", body: [] };
    }
    const nameNode = init.declarations[0]!.name;
    const v: Var = { id: this.nextVar++, name: nameNode.text, ty: elemTy(arr.ty.elem) };
    const sym = this.symbolOf(nameNode);
    if (sym !== undefined) this.scope.set(sym, v);
    return { k: "forof", v, arr, body: this.stmt(s.statement), loc: this.loc(s) };
  }

  switchStmt(s: ts.SwitchStatement): Stmt {
    const val = this.expr(s.expression);
    const k = val.ty.k;
    if (
      k === "float" ||
      k === "rec" ||
      k === "union" ||
      k === "arr" ||
      k === "fn" ||
      k === "bool"
    ) {
      this.err(s.expression, "TSL9001", "switch is on integers, enums, literal unions or tags");
    }
    const clauses: { keys: TE[]; isDefault: boolean; body: Stmt[] }[] = [];
    for (const c of s.caseBlock.clauses) {
      if (ts.isDefaultClause(c)) {
        clauses.push({ keys: [], isDefault: true, body: this.block(c.statements) });
        continue;
      }
      let key = this.expr(c.expression, val.ty);
      if (known(val.ty)) key = this.coerce(key, val.ty, c.expression);
      if (key.k !== "lit" && key.ty.k !== "unk") {
        this.err(c.expression, "TSL9001", "case labels must be constants");
      }
      clauses.push({ keys: [key], isDefault: false, body: this.block(c.statements) });
    }
    return { k: "switch", val, clauses };
  }

  varList(list: ts.VariableDeclarationList): Stmt[] {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    const out: Stmt[] = [];
    for (const d of list.declarations) out.push(...this.varDecl(d, isConst));
    return out;
  }

  newHidden(ty: Ty): Var {
    return { id: this.nextVar++, name: `$t${this.nextHidden++}`, ty };
  }

  varDecl(d: ts.VariableDeclaration, isConst: boolean): Stmt[] {
    if (ts.isObjectBindingPattern(d.name)) return this.destructure(d, d.name, isConst);
    if (!ts.isIdentifier(d.name)) {
      this.err(d, "TSL9001", "array destructuring is not in M1's subset");
      return [];
    }
    const sym = this.symbolOf(d.name);
    if (sym === undefined) return [];
    const name = d.name.text;
    if (d.type !== undefined) {
      const ty = this.typeOf(d.type);
      const v: Var = { id: this.nextVar++, name, ty };
      this.scope.set(sym, v);
      if (d.initializer === undefined) return [{ k: "let", v, init: null, constant: isConst }];
      const init = this.coerce(this.expr(d.initializer, ty), ty, d.initializer);
      return [{ k: "let", v, init, constant: isConst }];
    }
    if (d.initializer === undefined) {
      this.err(d, "TSL2001", `no evidence for the type of ${name}: annotate it`);
      return [];
    }
    if (isConst && ts.isElementAccessExpression(d.initializer)) {
      const read = this.nullableIndex(d.initializer);
      if (read !== null) {
        const v: Var = { id: this.nextVar++, name, ty: read.ty };
        this.scope.set(sym, v);
        return [{ k: "let", v, init: read, constant: true }];
      }
    }
    if (isConst) {
      const folded = this.fold(d.initializer);
      if (folded !== null) {
        // An untyped constant: no storage, and it adapts to its context like a literal.
        this.scope.set(sym, { value: folded });
        return [];
      }
    }
    if (!this.dry) {
      const ty = this.finalTy.get(sym) ?? T.unk;
      const v: Var = { id: this.nextVar++, name, ty };
      this.scope.set(sym, v);
      const init = this.coerce(this.expr(d.initializer, ty), ty, d.initializer);
      return [{ k: "let", v, init, constant: isConst }];
    }
    let cls = this.infer.get(sym);
    if (cls === undefined) {
      cls = { parent: null, ev: null, weak: false, conflict: false };
      this.infer.set(sym, cls);
    }
    const init = this.expr(d.initializer);
    const v: Var = { id: this.nextVar++, name, ty: T.unk };
    this.inferByVar.set(v, cls);
    this.scope.set(sym, v);
    this.flowInto(cls, init);
    return [{ k: "let", v, init, constant: isConst }];
  }

  destructure(d: ts.VariableDeclaration, pat: ts.ObjectBindingPattern, isConst: boolean): Stmt[] {
    if (d.initializer === undefined) return [];
    const annotated = d.type !== undefined ? this.typeOf(d.type) : undefined;
    const init = this.expr(d.initializer, annotated);
    const tmp = this.newHidden(init.ty);
    const out: Stmt[] = [{ k: "let", v: tmp, init, constant: true }];
    for (const el of pat.elements) {
      if (el.initializer !== undefined || el.dotDotDotToken !== undefined) {
        this.err(el, "TSL1008", "destructuring defaults and rest rely on undefined");
        continue;
      }
      if (!ts.isIdentifier(el.name)) {
        this.err(el, "TSL9001", "nested destructuring is not in M1's subset");
        continue;
      }
      const field = el.propertyName ?? el.name;
      if (!ts.isIdentifier(field)) {
        this.err(el, "TSL9001", "computed destructuring is banned");
        continue;
      }
      const te = this.fieldOf(mk(tmp.ty, { k: "var", v: tmp }), field.text, el, d.initializer);
      const v: Var = { id: this.nextVar++, name: el.name.text, ty: te.ty };
      const sym = this.symbolOf(el.name);
      if (sym !== undefined) this.scope.set(sym, v);
      out.push({ k: "let", v, init: te, constant: isConst });
    }
    return out;
  }

  // --- inference evidence

  evidence(cls: Cls, ty: Ty): void {
    if (!known(ty) || ty.k === "never" || ty.k === "void") return;
    const c = find(cls);
    if (c.ev === null) {
      c.ev = ty;
      this.changed = true;
      return;
    }
    // A value type's first evidence is its initialiser, and later uses are ordinary coercions. So is a nullable scalar's:
    // its uses are of what's left once it's narrowed (SPEC 3.3, rule 12).
    if (c.ev.k === "opt") return;
    if (!isNumericTy(c.ev) && !isNumericTy(ty)) return;
    const j = isNumericTy(c.ev) && isNumericTy(ty) ? joinNumeric(c.ev, ty) : null;
    if (j === null) {
      if (!c.conflict) this.changed = true;
      c.conflict = true;
      return;
    }
    if (tyKey(j) !== tyKey(c.ev)) {
      c.ev = j;
      this.changed = true;
    }
  }

  unify(a: Cls, b: Cls): void {
    const x = find(a);
    const y = find(b);
    if (x === y) return;
    y.parent = x;
    this.changed = true;
    x.weak ||= y.weak;
    x.conflict ||= y.conflict;
    if (y.ev !== null) this.evidence(x, y.ev);
  }

  flowInto(cls: Cls, te: TE): void {
    if (te.ty.k === "lit-num" && te.k === "lit" && typeof te.value === "number") {
      // A non-integer literal can only be a float, so that's evidence by itself.
      if (!Number.isInteger(te.value)) this.evidence(cls, T.f64);
    }
    if (te.deps !== undefined) for (const d of te.deps) this.unify(cls, d as Cls);
    this.evidence(cls, te.ty);
  }

  addDeps(te: TE, ty: Ty): void {
    if (this.dry && te.deps !== undefined) {
      for (const d of te.deps) this.evidence(d as Cls, ty);
    }
  }

  mergeDeps(...tes: TE[]): unknown[] | undefined {
    if (!this.dry) return undefined;
    const out: unknown[] = [];
    for (const t of tes) if (t.deps !== undefined) out.push(...t.deps);
    return out.length > 0 ? out : undefined;
  }

  // --- coercion: the implicit conversions

  coerce(te: TE, target: Ty, node: ts.Node): TE {
    this.addDeps(te, target);
    if (target.k === "unk" || te.ty.k === "unk") return te;
    if (te.ty.k === "never") return te;
    if (te.ty.k === "lit-num" || te.ty.k === "lit-big") return this.coerceLit(te, target, node);
    if (tyKey(te.ty) === tyKey(target)) return te;
    if (te.ty.k === "int" && target.k === "int") {
      if (intWidens(te.ty.name, target.name)) return mk(target, { k: "conv", val: te });
      if (te.k === "lit" && typeof te.value === "number" && inRange(te.value, target.name)) {
        return mk(target, { k: "lit", value: te.value });
      }
      const r = te.range;
      if (r !== undefined) {
        const [lo, hi] = INT_RANGE[target.name];
        if (r[0] >= lo && r[1] <= hi) return mk(target, { k: "conv", val: te });
      }
    }
    if (te.ty.k === "float" && target.k === "float" && target.name === "f64") {
      return mk(target, { k: "conv", val: te });
    }
    if (te.ty.k === "lits" && target.k === "lits" && te.ty.kind === target.kind) {
      const allowed = new Set<string | number>(target.values);
      if (te.ty.values.every((v) => allowed.has(v))) {
        if (te.k === "lit") return mk(target, { k: "lit", value: te.value });
        return mk(target, { k: "conv", val: te });
      }
    }
    if (te.ty.k === "rec" && (target.k === "rec" || target.k === "union")) {
      return this.coerceRecord(te, target, node);
    }
    if (te.ty.k === "union" || target.k === "union") {
      return this.err(node, "TSL3005", "a value union can't be assigned to a looser type");
    }
    if (te.ty.k === "float" && target.k === "float") {
      return this.err(node, "TSL2006", "f64 doesn't narrow to f32 implicitly: use Math.fround");
    }
    return this.err(node, "TSL2006", `${tyName(te.ty)} doesn't widen to ${tyName(target)}`);
  }

  coerceLit(te: TE, target: Ty, node: ts.Node): TE {
    if (te.k !== "lit") return te;
    const v = te.value;
    if (target.k === "int") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        return this.err(node, "TSL2002", `${String(v)} is not an integer`);
      }
      if (!inRange(v, target.name)) {
        return this.err(node, "TSL2002", `${v} is out of range for ${target.name}`);
      }
      return mk(target, { k: "lit", value: v === 0 ? 0 : v });
    }
    if (target.k === "big") {
      if (typeof v !== "bigint") return this.err(node, "TSL2006", "a number can't become a bigint");
      const ok =
        target.name === "u64" ? v >= 0n && v < 1n << 64n : v >= -(1n << 63n) && v < 1n << 63n;
      if (!ok) return this.err(node, "TSL2002", `${v} is out of range for ${target.name}`);
      return mk(target, { k: "lit", value: v });
    }
    if (target.k === "float") {
      if (typeof v !== "number") return this.err(node, "TSL2006", "a bigint can't become a float");
      if (target.name === "f32" && Math.fround(v) !== v && !Number.isNaN(v)) {
        return this.err(node, "TSL2002", `${v} isn't exact in f32: use Math.fround`);
      }
      return mk(target, { k: "lit", value: v });
    }
    if (target.k === "lits" && target.kind === "num" && typeof v === "number") {
      if (target.values.includes(v)) return mk(target, { k: "lit", value: v });
      return this.err(node, "TSL2002", `${v} is not in this literal union`);
    }
    return this.err(node, "TSL2006", `a literal doesn't convert to ${tyName(target)}`);
  }

  coerceRecord(te: TE, target: Ty, node: ts.Node): TE {
    const from = te.ty;
    if (from.k !== "rec") return te;
    // A record holding a literal tag still isn't a union: only an object literal builds one (3.5).
    if (target.k === "union") {
      return this.err(node, "TSL3005", "a value union is only built from an object literal");
    }
    // The source is read once per field, so hold it in a temporary rather than re-evaluate it.
    const tmp = this.newHidden(from);
    const save = mk(from, { k: "setvar", v: tmp, val: te });
    const held = mk(from, { k: "var", v: tmp });
    if (target.k === "rec") {
      const fields: { name: string; val: TE }[] = [];
      for (const f of target.fields) {
        const fieldTy = this.fieldTy(from, f.name);
        if (fieldTy.k === "unk") {
          return this.err(node, "TSL3005", "a value record can't be assigned to a looser type");
        }
        const val = mk(fieldTy, { k: "field", obj: held, name: f.name });
        fields.push({ name: f.name, val: this.coerce(val, f.ty, node) });
      }
      const built = mk(target, { k: "record", fields });
      return mk(target, { k: "seq", items: [save], result: built });
    }
    return te;
  }

  fieldTy(r: Ty, name: string): Ty {
    if (r.k !== "rec") return T.unk;
    return r.fields.find((f) => f.name === name)?.ty ?? T.unk;
  }

  // --- expressions

  exprStmt(e: ts.Expression): TE {
    const inner = stripParens(e);
    if (ts.isPostfixUnaryExpression(inner))
      return this.update(inner, inner.operand, inner.operator, false);
    return this.expr(e);
  }

  expr(e: ts.Expression, expected?: Ty, wrap = false): TE {
    if (ts.isParenthesizedExpression(e)) return this.expr(e.expression, expected, wrap);
    if (ts.isAsExpression(e)) return this.expr(e.expression, expected, wrap);
    const folded = this.fold(e);
    if (folded !== null) {
      return typeof folded === "number"
        ? mk(T.litNum, { k: "lit", value: folded })
        : mk(T.litBig, { k: "lit", value: folded });
    }
    if (ts.isNonNullExpression(e)) {
      const inner = stripParens(e.expression);
      if (ts.isElementAccessExpression(inner)) return this.elementRead(inner, e);
      return this.expr(e.expression, expected, wrap);
    }
    switch (e.kind) {
      case ts.SyntaxKind.TrueKeyword:
        return mk(T.bool, { k: "lit", value: true });
      case ts.SyntaxKind.FalseKeyword:
        return mk(T.bool, { k: "lit", value: false });
      case ts.SyntaxKind.StringLiteral:
        return this.stringLit(e as ts.StringLiteral, expected);
      case ts.SyntaxKind.Identifier:
        return this.identifier(e as ts.Identifier);
      case ts.SyntaxKind.BinaryExpression:
        return this.binary(e as ts.BinaryExpression, expected, wrap);
      case ts.SyntaxKind.PrefixUnaryExpression:
        return this.prefix(e as ts.PrefixUnaryExpression, expected, wrap);
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const p = e as ts.PostfixUnaryExpression;
        return this.update(p, p.operand, p.operator, true);
      }
      case ts.SyntaxKind.ConditionalExpression:
        return this.conditional(e as ts.ConditionalExpression, expected);
      case ts.SyntaxKind.CallExpression:
        return this.call(e as ts.CallExpression, expected);
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.property(e as ts.PropertyAccessExpression);
      case ts.SyntaxKind.ElementAccessExpression:
        return this.elementRead(e as ts.ElementAccessExpression, e);
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.objectLit(e as ts.ObjectLiteralExpression, expected);
      default:
        return this.err(e, "TSL9001", "this expression is not in M1's subset");
    }
  }

  stringLit(e: ts.StringLiteral, expected?: Ty): TE {
    if (expected !== undefined && expected.k === "lits" && expected.kind === "str") {
      return mk({ k: "lits", kind: "str", values: [e.text] }, { k: "lit", value: e.text });
    }
    if (expected?.k === "unk") return mk(T.unk, { k: "err" });
    return this.err(
      e,
      "TSL1007",
      "no run-time strings: a string literal needs a literal-union context",
    );
  }

  identifier(e: ts.Identifier): TE {
    const sym =
      e.parent !== undefined && ts.isShorthandPropertyAssignment(e.parent)
        ? this.checker.getShorthandAssignmentValueSymbol(e.parent)
        : this.symbolOf(e);
    if (sym === undefined) return this.err(e, "TSL9001", `unknown name ${e.text}`);
    return this.readSymbol(sym, e);
  }

  /** a[i] with no assertion, on a typed array: a nullable scalar (SPEC 3.3, rule 12). */
  nullableIndex(e: ts.ElementAccessExpression): TE | null {
    const arr = this.expr(e.expression);
    if (arr.ty.k !== "arr") return null;
    const idx = this.indexOf(e.argumentExpression);
    return mk({ k: "opt", of: elemTy(arr.ty.elem) }, { k: "optindex", arr, idx });
  }

  /** The one way to test a nullable scalar. Anything else, the checker hasn't narrowed. */
  undefinedTest(e: ts.BinaryExpression, op: string): TE | null {
    if (op !== "eq" && op !== "ne") return null;
    const isUndef = (x: ts.Expression): boolean =>
      ts.isIdentifier(stripParens(x)) && (stripParens(x) as ts.Identifier).text === "undefined";
    const other = isUndef(e.right) ? e.left : isUndef(e.left) ? e.right : null;
    if (other === null) return null;
    const x = stripParens(other);
    let val: TE | null = null;
    if (ts.isElementAccessExpression(x)) val = this.nullableIndex(x);
    else if (ts.isIdentifier(x)) {
      const sym = this.symbolOf(x);
      const local = sym !== undefined ? this.scope.get(sym) : undefined;
      if (local !== undefined && !("value" in local) && local.ty.k === "opt") {
        val = mk(local.ty, { k: "var", v: local });
      }
    }
    if (val === null) return this.err(e, "TSL1008", "undefined only tests a typed array's a[i]");
    return mk(T.bool, { k: "isundef", val, negate: op === "ne" });
  }

  readSymbol(sym: ts.Symbol, e: ts.Node): TE {
    const local = this.scope.get(sym);
    if (local !== undefined) {
      if ("value" in local) {
        const v = local.value;
        return typeof v === "number"
          ? mk(T.litNum, { k: "lit", value: v })
          : mk(T.litBig, { k: "lit", value: v });
      }
      if (local.ty.k === "opt") {
        const t = this.checker.getTypeAtLocation(e);
        const parts = t.isUnion() ? t.types : [t];
        if (parts.some((p) => (p.flags & ts.TypeFlags.Undefined) !== 0)) {
          const d = sym.valueDeclaration as ts.VariableDeclaration | undefined;
          return this.err(
            d?.initializer ?? e,
            "TSL1008",
            "narrow a[i] with === undefined before using it",
          );
        }
        return mk(local.ty.of, { k: "optpayload", val: mk(local.ty, { k: "var", v: local }) });
      }
      const cls = this.inferByVar.get(local);
      if (cls !== undefined) {
        const c = find(cls);
        return mk(c.ev ?? T.unk, { k: "var", v: local }, [c]);
      }
      return mk(local.ty, { k: "var", v: local });
    }
    const top = this.top.get(sym);
    if (top === undefined) {
      if (this.isCoreSymbol(sym)) {
        return this.err(e, "TSL9001", `${sym.name} can only be called`);
      }
      return this.err(e, "TSL9001", `${sym.name} is not usable as a value`);
    }
    switch (top.kind) {
      case "const":
        return typeof top.value === "number"
          ? mk(T.litNum, { k: "lit", value: top.value })
          : mk(T.litBig, { k: "lit", value: top.value });
      case "typed":
        return mk(top.ty, { k: "lit", value: top.value });
      case "global":
        if (top.def.table !== undefined) {
          return this.err(e, "TSL1006", "a dispatch table can only be indexed");
        }
        return mk(top.def.ty, { k: "global", g: top.def });
      case "func": {
        if (top.decl.typeParameters !== undefined) {
          return this.err(e, "TSL9001", "a generic function needs instantiating to be a value");
        }
        const ty = this.fnTyOf(top.decl);
        if (this.dry) return mk(ty, { k: "err" });
        return mk(ty, { k: "fnref", inst: this.instance(top.decl, [], e) });
      }
    }
  }

  isWrapMaskConstant(e: ts.Expression): boolean {
    const v = this.fold(e);
    return v !== null;
  }

  binary(e: ts.BinaryExpression, expected: Ty | undefined, wrap: boolean): TE {
    const op = e.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.CommaToken: {
        const a = this.exprStmt(e.left);
        const b = this.expr(e.right, expected);
        return mk(b.ty, { k: "seq", items: [a], result: b }, b.deps);
      }
      case ts.SyntaxKind.EqualsToken:
        return this.assign(e);
      case ts.SyntaxKind.PlusEqualsToken:
        return this.compound(e, "add");
      case ts.SyntaxKind.MinusEqualsToken:
        return this.compound(e, "sub");
      case ts.SyntaxKind.AsteriskEqualsToken:
        return this.compound(e, "mul");
      case ts.SyntaxKind.SlashEqualsToken:
        return this.compound(e, "div");
      case ts.SyntaxKind.PercentEqualsToken:
        return this.compound(e, "rem");
      case ts.SyntaxKind.AmpersandEqualsToken:
        return this.compound(e, "and");
      case ts.SyntaxKind.BarEqualsToken:
        return this.compound(e, "or");
      case ts.SyntaxKind.CaretEqualsToken:
        return this.compound(e, "xor");
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
        return this.compound(e, "shl");
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
        return this.compound(e, "shr");
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        return this.compound(e, "ushr");
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken: {
        const name =
          op === ts.SyntaxKind.PlusToken ? "add" : op === ts.SyntaxKind.MinusToken ? "sub" : "mul";
        const a = this.expr(e.left, expected, wrap);
        const b = this.expr(e.right, expected, wrap);
        return this.arith(e, name, a, b, wrap);
      }
      case ts.SyntaxKind.SlashToken:
        return this.arith(
          e,
          "div",
          this.expr(e.left, expected),
          this.expr(e.right, expected),
          false,
        );
      case ts.SyntaxKind.PercentToken:
        return this.arith(
          e,
          "rem",
          this.expr(e.left, expected),
          this.expr(e.right, expected),
          false,
        );
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return this.err(e, "TSL9001", "** on run-time values is not in M1's subset");
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.CaretToken: {
        const name =
          op === ts.SyntaxKind.AmpersandToken
            ? "and"
            : op === ts.SyntaxKind.BarToken
              ? "or"
              : "xor";
        const rightZero = this.fold(e.right) === 0;
        const wrapLeft =
          (name === "or" && rightZero) || (name === "and" && this.isWrapMaskConstant(e.right));
        const wrapRight = name === "and" && this.isWrapMaskConstant(e.left);
        const a = this.expr(e.left, undefined, wrapLeft);
        const b = this.expr(e.right, undefined, wrapRight);
        return this.bitop(e, name, a, b);
      }
      case ts.SyntaxKind.LessThanLessThanToken:
        return this.shift(e, "shl", this.expr(e.left, expected), this.expr(e.right), wrap);
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return this.shift(e, "shr", this.expr(e.left, expected), this.expr(e.right), wrap);
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: {
        const wrapLeft = this.fold(e.right) === 0;
        return this.shift(
          e,
          "ushr",
          this.expr(e.left, undefined, wrapLeft),
          this.expr(e.right),
          false,
        );
      }
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return this.err(e, "TSL2020", "== and != are banned: use === and !==");
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return this.compare(e, "eq");
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return this.compare(e, "ne");
      case ts.SyntaxKind.LessThanToken:
        return this.compare(e, "lt");
      case ts.SyntaxKind.LessThanEqualsToken:
        return this.compare(e, "le");
      case ts.SyntaxKind.GreaterThanToken:
        return this.compare(e, "gt");
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return this.compare(e, "ge");
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken: {
        const a = this.condition(e.left);
        const b = this.condition(e.right);
        const name = op === ts.SyntaxKind.BarBarToken ? "or" : "and";
        return mk(T.bool, { k: "logic", op: name, a, b });
      }
      default:
        return this.err(e, "TSL9001", "this operator is not in M1's subset");
    }
  }

  /** Numeric peers: a literal adapts to the other side, and typed sides meet at their join. */
  peer(node: ts.Node, a0: TE, b0: TE): { a: TE; b: TE; ty: Ty; deps?: unknown[] } {
    let a = a0;
    let b = b0;
    const deps = this.mergeDeps(a, b);
    if (this.dry) {
      if (a.deps !== undefined && b.deps !== undefined) {
        const first = a.deps[0] as Cls;
        for (const d of [...a.deps, ...b.deps]) this.unify(first, d as Cls);
      }
      if (known(b.ty)) this.addDeps(a, b.ty);
      if (known(a.ty)) this.addDeps(b, a.ty);
    }
    if (a.ty.k === "unk" || b.ty.k === "unk") {
      const other = a.ty.k === "unk" ? b : a;
      const r: { a: TE; b: TE; ty: Ty; deps?: unknown[] } = {
        a,
        b,
        ty: known(other.ty) ? other.ty : T.unk,
      };
      if (deps !== undefined) r.deps = deps;
      return r;
    }
    if (isLitTy(a.ty) && isLitTy(b.ty)) {
      if (a.ty.k !== b.ty.k) return { a, b, ty: T.unk };
      return { a, b, ty: a.ty };
    }
    let ty: Ty;
    if (isLitTy(a.ty)) {
      a = this.coerce(a, b.ty, a0 === a ? litNode(node, 0) : node);
      ty = b.ty;
    } else if (isLitTy(b.ty)) {
      b = this.coerce(b, a.ty, litNode(node, 1));
      ty = a.ty;
    } else {
      const j = joinNumeric(a.ty, b.ty);
      if (j === null) {
        this.err(node, "TSL2003", `${tyName(a.ty)} and ${tyName(b.ty)} have no join: convert one`);
        return { a, b, ty: T.unk };
      }
      ty = j;
    }
    if (tyKey(a.ty) !== tyKey(ty) && a.ty.k !== "unk") a = mk(ty, { k: "conv", val: a });
    if (tyKey(b.ty) !== tyKey(ty) && b.ty.k !== "unk") b = mk(ty, { k: "conv", val: b });
    const r: { a: TE; b: TE; ty: Ty; deps?: unknown[] } = { a, b, ty };
    if (deps !== undefined) r.deps = deps;
    return r;
  }

  arith(
    node: ts.BinaryExpression,
    op: "add" | "sub" | "mul" | "div" | "rem",
    a0: TE,
    b0: TE,
    wrap: boolean,
  ): TE {
    const { a, b, ty, deps } = this.peer(node, a0, b0);
    if (ty.k === "unk") return mk(T.unk, { k: "err" }, deps);
    const loc = this.loc(node);
    if (ty.k === "lit-num" || ty.k === "lit-big") return mk(ty, { k: "err" }, deps);
    if (ty.k === "float") {
      const fa = tyKey(a.ty) === "f64" ? a : mk(T.f64, { k: "conv", val: a });
      const fb = tyKey(b.ty) === "f64" ? b : mk(T.f64, { k: "conv", val: b });
      return mk(T.f64, { k: "farith", op, a: fa, b: fb }, deps);
    }
    if (ty.k === "int") {
      if (op === "div") {
        return this.err(node, "TSL2010", "/ on integers gives a fraction in JS: use idiv(a, b)");
      }
      if (wrap && op === "mul" && !(this.narrowMul(a0) && this.narrowMul(b0))) {
        return this.err(node, "TSL2012", "V8's product would be inexact: use Math.imul(a, b)");
      }
      return mk(ty, { k: "arith", op, a, b, wrap: wrap && op !== "rem", loc }, deps);
    }
    if (ty.k === "big") {
      const name = op === "div" ? "idiv" : op;
      return mk(
        ty,
        { k: "arith", op: name, a, b, wrap: wrap && op !== "rem" && op !== "div", loc },
        deps,
      );
    }
    return this.err(node, "TSL2003", `arithmetic doesn't apply to ${tyName(ty)}`);
  }

  /** Under a wrap context, * needs both operands to be 16 bits or fewer, and no nested arithmetic. */
  narrowMul(te: TE): boolean {
    if (te.k === "lit" && typeof te.value === "number") return Math.abs(te.value) <= 65535;
    if (te.k === "arith" || te.k === "farith" || te.k === "bit") return false;
    return (
      tyKey(te.ty) === "u8" ||
      tyKey(te.ty) === "i8" ||
      tyKey(te.ty) === "u16" ||
      tyKey(te.ty) === "i16"
    );
  }

  /** The operand of a number-backed bitwise op: 32 bits or fewer, or a float through ToInt32. */
  bitOperand(te: TE, node: ts.Node): TE {
    if (te.ty.k === "unk") return te;
    if (te.k === "lit" && te.ty.k === "lit-num" && typeof te.value === "number") {
      const v = te.value;
      if (!Number.isInteger(v) || v < -2147483648 || v > 4294967295) {
        return this.err(node, "TSL2002", `${v} is not a 32-bit operand`);
      }
      return mk(T.i32, { k: "lit", value: v | 0 });
    }
    if (te.ty.k === "int") {
      if (te.ty.name === "usize") {
        return this.err(
          node,
          "TSL2004",
          "bitwise ops don't apply to usize: use toU32 or toI32 first",
        );
      }
      return te;
    }
    if (te.ty.k === "float") return te;
    return this.err(node, "TSL2003", `bitwise ops don't apply to ${tyName(te.ty)}`);
  }

  bitop(node: ts.BinaryExpression, op: "and" | "or" | "xor", a0: TE, b0: TE): TE {
    if (a0.ty.k === "big" || b0.ty.k === "big" || a0.ty.k === "lit-big" || b0.ty.k === "lit-big") {
      const { a, b, ty, deps } = this.peer(node, a0, b0);
      if (ty.k !== "big") return mk(T.unk, { k: "err" }, deps);
      return mk(ty, { k: "bit", op, a, b }, deps);
    }
    const a = this.bitOperand(a0, node.left);
    const b = this.bitOperand(b0, node.right);
    const te = mk(T.i32, { k: "bit", op, a, b });
    if (op === "and") {
      const k = this.maskOf(a0) ?? this.maskOf(b0);
      if (k !== null && k >= 0 && k <= 2147483647) te.range = [0, k];
    }
    return te;
  }

  maskOf(te: TE): number | null {
    if (te.k === "lit" && typeof te.value === "number") return te.value;
    return null;
  }

  shift(node: ts.BinaryExpression, op: "shl" | "shr" | "ushr", a0: TE, b0: TE, wrap: boolean): TE {
    if (a0.ty.k === "big" || b0.ty.k === "big" || a0.ty.k === "lit-big" || b0.ty.k === "lit-big") {
      if (op === "ushr") return this.err(node, "TSL2003", ">>> doesn't apply to bigint");
      let a = a0;
      let b = b0;
      if (b.ty.k === "lit-big") b = this.coerce(b, T.u64, node.right);
      if (a.ty.k === "lit-big") {
        a = this.coerce(a, b.ty.k === "big" ? b.ty : T.u64, node.left);
      }
      if (a.ty.k !== "big" || b.ty.k !== "big") return mk(a.ty, { k: "err" }, this.mergeDeps(a, b));
      return mk(a.ty, { k: "bigshift", op, a, b, wrap: op === "shl" && wrap, loc: this.loc(node) });
    }
    const a = this.bitOperand(a0, node.left);
    const b = this.bitOperand(b0, node.right);
    const te = mk(op === "ushr" ? T.u32 : T.i32, { k: "bit", op, a, b });
    if (op === "ushr") {
      const n = this.maskOf(b0);
      // The count is masked first, so x >>> 32 is x >>> 0, which is a full u32.
      if (n !== null) te.range = [0, 2 ** (32 - (n & 31)) - 1];
    }
    return te;
  }

  compare(e: ts.BinaryExpression, op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"): TE {
    const tested = this.undefinedTest(e, op);
    if (tested !== null) return tested;
    let a: TE;
    let b: TE;
    // A string literal takes its literal-union type from the other side.
    if (stripParens(e.left).kind === ts.SyntaxKind.StringLiteral) {
      b = this.expr(e.right);
      a = this.expr(e.left, b.ty);
    } else {
      a = this.expr(e.left);
      b = this.expr(e.right, a.ty);
    }
    return this.compareTe(e, op, a, b);
  }

  compareTe(
    e: ts.BinaryExpression,
    op: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
    a0: TE,
    b0: TE,
  ): TE {
    if (a0.ty.k === "lits" && b0.ty.k === "lits") {
      if (op !== "eq" && op !== "ne") return this.err(e, "TSL2003", "literal unions have no order");
      return mk(T.bool, { k: "cmp", op, a: a0, b: b0 });
    }
    const p = this.peer(e, a0, b0);
    if (p.ty.k === "unk") return mk(T.bool, { k: "err" });
    if (p.ty.k === "lit-num" || p.ty.k === "lit-big") {
      const target = p.ty.k === "lit-num" ? T.f64 : T.i64;
      return mk(T.bool, {
        k: "cmp",
        op,
        a: this.coerce(p.a, target, e.left),
        b: this.coerce(p.b, target, e.right),
      });
    }
    if (isNumericTy(p.ty)) return mk(T.bool, { k: "cmp", op, a: p.a, b: p.b });
    if (op === "eq" || op === "ne") {
      if (p.ty.k === "bool" || p.ty.k === "enum" || p.ty.k === "lits") {
        return mk(T.bool, { k: "cmp", op, a: p.a, b: p.b });
      }
      return this.err(e, "TSL2020", `${tyName(p.ty)} has no equality`);
    }
    return this.err(e, "TSL2003", `${tyName(p.ty)} has no order`);
  }

  prefix(e: ts.PrefixUnaryExpression, expected: Ty | undefined, wrap: boolean): TE {
    switch (e.operator) {
      case ts.SyntaxKind.ExclamationToken:
        return mk(T.bool, { k: "not", a: this.condition(e.operand) });
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        return this.update(e, e.operand, e.operator, false);
      case ts.SyntaxKind.PlusToken:
        return this.expr(e.operand, expected);
      case ts.SyntaxKind.MinusToken: {
        const a = this.expr(e.operand, expected);
        if (a.ty.k === "unk") return mk(T.unk, { k: "err" }, a.deps);
        if (a.ty.k === "float") {
          const f = tyKey(a.ty) === "f64" ? a : mk(T.f64, { k: "conv", val: a });
          return mk(T.f64, { k: "neg", a: f, loc: this.loc(e) });
        }
        if (
          (a.ty.k === "int" && a.ty.name.startsWith("i")) ||
          (a.ty.k === "big" && a.ty.name === "i64")
        ) {
          return mk(a.ty, { k: "neg", a, loc: this.loc(e) }, a.deps);
        }
        return this.err(e, "TSL2003", `${tyName(a.ty)} is unsigned: negating it has no type`);
      }
      case ts.SyntaxKind.TildeToken: {
        const a = this.expr(e.operand);
        if (a.ty.k === "big") {
          if (a.ty.name === "u64" && !wrap) {
            return this.err(
              e,
              "TSL2013",
              "~ on u64 is negative in JS: wrap it in BigInt.asUintN(64, ~x)",
            );
          }
          return mk(a.ty, { k: "bitnot", a });
        }
        return mk(T.i32, { k: "bitnot", a: this.bitOperand(a, e.operand) });
      }
      default:
        return this.err(e, "TSL9001", "this operator is not in M1's subset");
    }
  }

  conditional(e: ts.ConditionalExpression, expected?: Ty): TE {
    const c = this.condition(e.condition);
    const a0 = this.expr(e.whenTrue, expected);
    const b0 = this.expr(e.whenFalse, expected);
    if (a0.ty.k === "never") return mk(b0.ty, { k: "cond", c, a: a0, b: b0 }, b0.deps);
    if (b0.ty.k === "never") return mk(a0.ty, { k: "cond", c, a: a0, b: b0 }, a0.deps);
    if (expected !== undefined && known(expected)) {
      const a = this.coerce(a0, expected, e.whenTrue);
      const b = this.coerce(b0, expected, e.whenFalse);
      return mk(expected, { k: "cond", c, a, b }, this.mergeDeps(a, b));
    }
    if (a0.ty.k === "lits" || a0.ty.k === "bool" || a0.ty.k === "rec" || a0.ty.k === "union") {
      return mk(a0.ty, { k: "cond", c, a: a0, b: this.coerce(b0, a0.ty, e.whenFalse) });
    }
    const p = this.peer(e, a0, b0);
    return mk(p.ty, { k: "cond", c, a: p.a, b: p.b }, p.deps);
  }

  // --- assignment

  lhsNode(e: ts.Expression): ts.Expression {
    return stripParens(e);
  }

  assignVar(v: Var, val: TE, node: ts.Node): TE {
    const cls = this.inferByVar.get(v);
    if (cls !== undefined) {
      this.flowInto(cls, val);
      return mk(val.ty, { k: "setvar", v, val }, [cls]);
    }
    const c = this.coerce(val, v.ty, node);
    return mk(c.ty, { k: "setvar", v, val: c });
  }

  assign(e: ts.BinaryExpression): TE {
    const lhs = this.lhsNode(e.left);
    if (ts.isIdentifier(lhs)) {
      const target = this.symbolOf(lhs);
      if (target === undefined) return this.err(lhs, "TSL9001", "unknown assignment target");
      const local = this.scope.get(target);
      if (local !== undefined && !("value" in local)) {
        const cls = this.inferByVar.get(local);
        const rhs = this.expr(e.right, cls !== undefined ? undefined : local.ty);
        return this.assignVar(local, rhs, e.right);
      }
      const top = this.top.get(target);
      if (top?.kind === "global" && top.def.mutable) {
        const rhs = this.expr(e.right, top.def.ty);
        const val = this.coerce(rhs, top.def.ty, e.right);
        return mk(val.ty, { k: "setglobal", g: top.def, val });
      }
      return this.err(lhs, "TSL9001", "this binding can't be assigned");
    }
    if (ts.isElementAccessExpression(lhs)) {
      const arr = this.expr(lhs.expression);
      const idx = this.indexOf(lhs.argumentExpression);
      const elemExpected = arr.ty.k === "arr" ? elemTy(arr.ty.elem) : undefined;
      const rhs = this.expr(e.right, elemExpected);
      return this.setIndex(e, arr, idx, rhs, e.right);
    }
    return this.err(lhs, "TSL9001", "this assignment target is not in M1's subset");
  }

  indexOf(node: ts.Expression): TE {
    const idx = this.expr(node, T.usize);
    if (this.dry) {
      if (idx.deps !== undefined) {
        for (const d of idx.deps) {
          const c = find(d as Cls);
          if (!c.weak) {
            c.weak = true;
            this.changed = true;
          }
        }
      }
      return idx;
    }
    return this.coerce(idx, T.usize, node);
  }

  setIndex(node: ts.Node, arr: TE, idx: TE, rhs: TE, rhsNode: ts.Node): TE {
    if (arr.ty.k !== "arr") {
      if (arr.ty.k === "unk") return mk(T.unk, { k: "err" });
      return this.err(node, "TSL1006", "only typed arrays can be indexed");
    }
    // A store to a Float32Array rounds, as in JS (SPEC 3.3, rule 10). Others take the element type.
    const target = arr.ty.elem === "f32" ? T.f64 : elemTy(arr.ty.elem);
    const val = this.coerce(rhs, target, rhsNode);
    return mk(val.ty, { k: "setindex", arr, idx, val, loc: this.loc(node) });
  }

  combine(
    e: ts.BinaryExpression,
    op: "add" | "sub" | "mul" | "div" | "rem" | "and" | "or" | "xor" | "shl" | "shr" | "ushr",
    a: TE,
    b: TE,
  ): TE {
    switch (op) {
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "rem":
        return this.arith(e, op, a, b, false);
      case "and":
      case "or":
      case "xor":
        return this.bitop(e, op, a, b);
      default:
        return this.shift(e, op, a, b, false);
    }
  }

  compound(
    e: ts.BinaryExpression,
    op: "add" | "sub" | "mul" | "div" | "rem" | "and" | "or" | "xor" | "shl" | "shr" | "ushr",
  ): TE {
    const lhs = this.lhsNode(e.left);
    if (ts.isIdentifier(lhs)) {
      const target = this.symbolOf(lhs);
      if (target === undefined) return this.err(lhs, "TSL9001", "unknown assignment target");
      const local = this.scope.get(target);
      const rhs = this.expr(
        e.right,
        local !== undefined && !("value" in local) ? local.ty : undefined,
      );
      const read = this.readSymbol(target, lhs);
      const val = this.combine(e, op, read, rhs);
      if (local !== undefined && !("value" in local)) return this.assignVar(local, val, e);
      const top = this.top.get(target);
      if (top?.kind === "global" && top.def.mutable) {
        const c = this.coerce(val, top.def.ty, e);
        return mk(c.ty, { k: "setglobal", g: top.def, val: c });
      }
      return this.err(lhs, "TSL9001", "this binding can't be assigned");
    }
    if (ts.isElementAccessExpression(lhs)) {
      const place = this.placeTemps(lhs);
      if (place === null) return mk(T.unk, { k: "err" });
      const rhs = this.expr(e.right, place.read.ty);
      const val = this.combine(e, op, place.read, rhs);
      const set = this.setIndex(e, place.arr, place.idx, val, e);
      return mk(set.ty, { k: "seq", items: place.temps, result: set });
    }
    return this.err(lhs, "TSL9001", "this assignment target is not in M1's subset");
  }

  /** Evaluates an array and index once, into hidden temporaries, for read-modify-write. */
  placeTemps(lhs: ts.ElementAccessExpression): { temps: TE[]; arr: TE; idx: TE; read: TE } | null {
    const arr0 = this.expr(lhs.expression);
    const idx0 = this.indexOf(lhs.argumentExpression);
    if (arr0.ty.k !== "arr") {
      if (arr0.ty.k !== "unk") this.err(lhs, "TSL1006", "only typed arrays can be indexed");
      return null;
    }
    const a = this.newHidden(arr0.ty);
    const i = this.newHidden(T.usize);
    const temps: TE[] = [
      mk(arr0.ty, { k: "setvar", v: a, val: arr0 }),
      mk(T.usize, { k: "setvar", v: i, val: idx0 }),
    ];
    const arr = mk(arr0.ty, { k: "var", v: a });
    const idx = mk(T.usize, { k: "var", v: i });
    const read = mk(elemTy(arr0.ty.elem), { k: "index", arr, idx, loc: this.loc(lhs) });
    return { temps, arr, idx, read };
  }

  update(
    e: ts.Expression,
    operand: ts.Expression,
    operator: ts.SyntaxKind,
    valueUsed: boolean,
  ): TE {
    if (operator !== ts.SyntaxKind.PlusPlusToken && operator !== ts.SyntaxKind.MinusMinusToken) {
      return this.err(e, "TSL9001", "this operator is not in M1's subset");
    }
    const op = operator === ts.SyntaxKind.PlusPlusToken ? "add" : "sub";
    const lhs = this.lhsNode(operand);
    const bin = e as unknown as ts.BinaryExpression;
    const oneFor = (t: TE): TE =>
      t.ty.k === "big"
        ? mk(T.litBig, { k: "lit", value: 1n })
        : mk(T.litNum, { k: "lit", value: 1 });
    if (ts.isIdentifier(lhs)) {
      const sym = this.symbolOf(lhs);
      if (sym === undefined) return this.err(lhs, "TSL9001", "unknown assignment target");
      const local = this.scope.get(sym);
      const read = this.readSymbol(sym, lhs);
      if (local !== undefined && !("value" in local)) {
        if (!valueUsed)
          return this.assignVar(local, this.arith(bin, op, read, oneFor(read), false), e);
        const old = this.newHidden(read.ty);
        const oldRead = mk(read.ty, { k: "var", v: old }, read.deps);
        const save = mk(read.ty, { k: "setvar", v: old, val: read });
        const next = this.assignVar(local, this.arith(bin, op, oldRead, oneFor(read), false), e);
        return mk(read.ty, { k: "seq", items: [save, next], result: oldRead }, read.deps);
      }
      const top = this.top.get(sym);
      if (top?.kind === "global" && top.def.mutable) {
        const old = this.newHidden(top.def.ty);
        const oldRead = mk(top.def.ty, { k: "var", v: old });
        const save = mk(top.def.ty, { k: "setvar", v: old, val: read });
        const val = this.coerce(this.arith(bin, op, oldRead, oneFor(read), false), top.def.ty, e);
        const next = mk(val.ty, { k: "setglobal", g: top.def, val });
        return mk(top.def.ty, { k: "seq", items: [save, next], result: oldRead });
      }
      return this.err(lhs, "TSL9001", "this binding can't be assigned");
    }
    if (ts.isElementAccessExpression(lhs)) {
      const place = this.placeTemps(lhs);
      if (place === null) return mk(T.unk, { k: "err" });
      const old = this.newHidden(place.read.ty);
      const oldRead = mk(place.read.ty, { k: "var", v: old });
      const save = mk(place.read.ty, { k: "setvar", v: old, val: place.read });
      const val = this.arith(bin, op, oldRead, oneFor(place.read), false);
      const set = this.setIndex(e, place.arr, place.idx, val, e);
      return mk(place.read.ty, { k: "seq", items: [...place.temps, save, set], result: oldRead });
    }
    return this.err(lhs, "TSL9001", "this assignment target is not in M1's subset");
  }

  // --- property and element access

  property(e: ts.PropertyAccessExpression): TE {
    const leftSym = ts.isIdentifier(e.expression) ? this.symbolOf(e.expression) : undefined;
    if (leftSym !== undefined) {
      const en = this.enumOf(leftSym);
      if (en !== undefined && en.k === "enum") {
        const v = en.members.get(e.name.text);
        if (v === undefined) return this.err(e, "TSL1011", "unknown enum member");
        return mk(en, { k: "lit", value: v });
      }
      if (this.isLibSymbol(leftSym)) {
        return this.err(
          e,
          "TSL1006",
          `${leftSym.name}.${e.name.text} is not in the allowed surface`,
        );
      }
    }
    return this.fieldOf(this.expr(e.expression), e.name.text, e, e.expression);
  }

  fieldOf(obj: TE, name: string, node: ts.Node, objNode: ts.Node): TE {
    const t = obj.ty;
    if (t.k === "unk") return mk(T.unk, { k: "err" });
    if (t.k === "arr") {
      if (name === "length") return mk(T.usize, { k: "len", arr: obj });
      return this.err(node, "TSL9001", `.${name} on typed arrays is not implemented in M1`);
    }
    if (t.k === "rec") {
      const ty = this.fieldTy(t, name);
      if (ty.k === "unk") return this.err(node, "TSL9001", `no field ${name}`);
      return mk(ty, { k: "field", obj, name });
    }
    if (t.k === "union") {
      if (name === t.tag) {
        const tags = t.variants.map((v) => v.tag);
        const first = tags[0];
        const ty: Ty =
          typeof first === "boolean"
            ? T.bool
            : {
                k: "lits",
                kind: typeof first === "string" ? "str" : "num",
                values: tags as (string | number)[],
              };
        return mk(ty, { k: "field", obj, name });
      }
      const holders = t.variants.filter((v) => v.slots.has(name));
      if (holders.length === 0) return this.err(node, "TSL9001", `no field ${name}`);
      const variant = this.narrowedVariant(t, holders, name, objNode);
      if (variant === null) {
        return this.err(
          node,
          "TSL3005",
          `${name} differs between variants: narrow on the tag first`,
        );
      }
      const f = variant.fields.find((x) => x.name === name)!;
      return mk(f.ty, { k: "field", obj, name, variant });
    }
    return this.err(node, "TSL9001", `${tyName(t)} has no fields`);
  }

  /** tsc has already proved the access valid, so only a choice between layouts needs narrowing. */
  narrowedVariant(
    u: Extract<Ty, { k: "union" }>,
    holders: Variant[],
    name: string,
    objNode: ts.Node,
  ): Variant | null {
    const first = holders[0]!;
    const same = holders.every(
      (v) =>
        tyKey(v.fields.find((f) => f.name === name)!.ty) ===
          tyKey(first.fields.find((f) => f.name === name)!.ty) &&
        v.slots.get(name)!.join() === first.slots.get(name)!.join(),
    );
    if (same) return first;
    const t = this.checker.getTypeAtLocation(objNode);
    const members = t.isUnion() ? t.types : [t];
    const tags = new Set<boolean | string | number>();
    for (const m of members) {
      const prop = m.getProperty(u.tag);
      if (prop === undefined) continue;
      const pt = this.checker.getTypeOfSymbolAtLocation(prop, objNode);
      if (pt.isStringLiteral() || pt.isNumberLiteral()) tags.add(pt.value);
      else {
        const text = this.checker.typeToString(pt);
        if (text === "true") tags.add(true);
        if (text === "false") tags.add(false);
      }
    }
    const matches = holders.filter((v) => tags.has(v.tag));
    return matches.length === 1 ? matches[0]! : null;
  }

  elementRead(e: ts.ElementAccessExpression, whole: ts.Expression): TE {
    const sym = ts.isIdentifier(e.expression) ? this.symbolOf(e.expression) : undefined;
    if (sym !== undefined) {
      if (this.enums.has(sym)) return this.err(e, "TSL1011", "reverse enum mapping is banned");
      const top = this.top.get(sym);
      if (top?.kind === "global" && top.def.table !== undefined) {
        if (!ts.isNonNullExpression(whole)) return this.err(whole, "TSL1008", "use table[i]!");
        const idx = this.indexOf(e.argumentExpression);
        return mk(top.def.ty, { k: "tableget", g: top.def, idx, loc: this.loc(e) });
      }
    }
    const arr = this.expr(e.expression);
    const idx = this.indexOf(e.argumentExpression);
    if (arr.ty.k === "unk") return mk(T.unk, { k: "err" });
    if (arr.ty.k !== "arr") return this.err(e, "TSL1006", "only typed arrays can be indexed");
    if (!ts.isNonNullExpression(whole)) {
      return this.err(
        whole,
        "TSL1008",
        "an indexed read must be a[i]!: undefined is not a value here",
      );
    }
    return mk(elemTy(arr.ty.elem), { k: "index", arr, idx, loc: this.loc(e) });
  }

  objectLit(e: ts.ObjectLiteralExpression, expected?: Ty): TE {
    if (expected === undefined || expected.k === "unk") {
      if (this.dry || expected?.k === "unk") {
        // Still walk the fields, because they may hold evidence.
        return mk(T.unk, { k: "err" });
      }
      return this.err(e, "TSL1005", "an object literal needs a declared value-record type");
    }
    const props: { name: string; init: ts.Expression; node: ts.ObjectLiteralElementLike }[] = [];
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        props.push({ name: p.name.text, init: p.initializer, node: p });
      } else if (ts.isShorthandPropertyAssignment(p)) {
        props.push({ name: p.name.text, init: p.name, node: p });
      } else return this.err(p, "TSL1005", "a value record literal has plain named fields");
    }
    if (expected.k === "rec") {
      const fields = props.map((p) => {
        const ty = this.fieldTy(expected, p.name);
        return { name: p.name, val: this.coerce(this.expr(p.init, ty), ty, p.init) };
      });
      return mk(expected, { k: "record", fields });
    }
    if (expected.k === "union") {
      const tagProp = props.find((p) => p.name === expected.tag);
      const tagNode = tagProp !== undefined ? stripParens(tagProp.init) : undefined;
      let tag: boolean | string | number | undefined;
      if (tagNode !== undefined) {
        if (tagNode.kind === ts.SyntaxKind.TrueKeyword) tag = true;
        else if (tagNode.kind === ts.SyntaxKind.FalseKeyword) tag = false;
        else if (ts.isStringLiteral(tagNode)) tag = tagNode.text;
        else if (ts.isNumericLiteral(tagNode)) tag = Number(tagNode.text);
      }
      const variant = expected.variants.find((v) => v.tag === tag);
      if (variant === undefined) {
        return this.err(
          e,
          "TSL3005",
          "a value union literal needs a literal tag naming its variant",
        );
      }
      const fields: { name: string; val: TE }[] = [];
      for (const p of props) {
        if (p.name === expected.tag) continue;
        const ty = variant.fields.find((f) => f.name === p.name)?.ty ?? T.unk;
        fields.push({ name: p.name, val: this.coerce(this.expr(p.init, ty), ty, p.init) });
      }
      return mk(expected, { k: "ulit", variant, tagText: String(tag), fields });
    }
    return this.err(e, "TSL1005", "object literals are only for value records");
  }

  // --- calls

  call(e: ts.CallExpression, expected?: Ty): TE {
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee)) return this.methodCall(e, callee, expected);
    const stripped = stripParens(callee);
    if (ts.isIdentifier(callee)) {
      const sym = this.symbolOf(callee);
      if (sym === undefined) return this.err(callee, "TSL9001", `unknown function ${callee.text}`);
      if (this.isCoreSymbol(sym)) return this.coreCall(e, sym.name, expected);
      const local = this.scope.get(sym);
      if (local === undefined) {
        const top = this.top.get(sym);
        if (top?.kind === "func") return this.directCall(e, top.decl, expected);
        return this.err(callee, "TSL9001", `${callee.text} is not callable`);
      }
    }
    if (ts.isIdentifier(stripped) || ts.isElementAccessExpression(stripped)) {
      const fn = this.expr(callee);
      if (fn.ty.k === "unk") return mk(T.unk, { k: "err" });
      if (fn.ty.k !== "fn") return this.err(callee, "TSL9001", "this value is not callable");
      const fnTy = fn.ty;
      if (e.arguments.length !== fnTy.params.length) return mk(fnTy.ret, { k: "err" });
      const args = e.arguments.map((a, i) => {
        const t = fnTy.params[i]!;
        return this.coerce(this.expr(a, t), t, a);
      });
      return mk(fnTy.ret, { k: "callind", fn, args });
    }
    return this.err(callee, "TSL9001", "this call form is not in M1's subset");
  }

  directCall(e: ts.CallExpression, decl: FnDecl, expected?: Ty): TE {
    const params = decl.parameters;
    const tps = decl.typeParameters;
    let env: Env = this.env;
    const tyArgs: Ty[] = [];
    let unresolved = false;
    const argTes: (TE | null)[] = e.arguments.map(() => null);
    const argDeps: unknown[] = [];
    if (tps !== undefined) {
      env = new Map(this.env);
      for (let i = 0; i < tps.length; i++) {
        const tp = tps[i]!;
        const s = this.checker.getSymbolAtLocation(tp.name)!;
        const explicit = e.typeArguments?.[i];
        let t: Ty | null = explicit !== undefined ? this.typeOf(explicit) : null;
        if (t === null) {
          for (let j = 0; j < params.length; j++) {
            const pt = params[j]!.type;
            if (pt === undefined || !ts.isTypeReferenceNode(pt)) continue;
            if (this.symbolOf(pt.typeName) !== s) continue;
            const argNode = e.arguments[j];
            if (argNode === undefined) continue;
            const a = argTes[j] ?? this.expr(argNode);
            argTes[j] = a;
            if (a.deps !== undefined) argDeps.push(...a.deps);
            if (!known(a.ty)) continue;
            if (t === null) t = a.ty;
            else {
              const j2 = joinNumeric(t, a.ty);
              if (j2 === null)
                return this.err(argNode, "TSL2003", "generic arguments have no join");
              t = j2;
            }
          }
          if (t === null && decl.type !== undefined && ts.isTypeReferenceNode(decl.type)) {
            if (
              this.symbolOf(decl.type.typeName) === s &&
              expected !== undefined &&
              known(expected)
            ) {
              t = expected;
            }
          }
        }
        if (t === null) {
          if (this.dry) {
            unresolved = true;
            env.set(s, T.unk);
            tyArgs.push(T.unk);
            continue;
          }
          return this.err(e, "TSL2001", "no evidence for this generic's type: give it explicitly");
        }
        if (
          t.k !== "unk" &&
          !isNumericTy(t) &&
          t.k !== "bool" &&
          t.k !== "enum" &&
          t.k !== "lits"
        ) {
          return this.err(e, "TSL9001", "M1's generics are over scalars");
        }
        env.set(s, t);
        tyArgs.push(t);
      }
    }
    const paramTys = params.map((p) => (p.type !== undefined ? this.typeOf(p.type, env) : T.unk));
    const ret = decl.type !== undefined ? this.typeOf(decl.type, env) : T.unk;
    const args = e.arguments.map((a, i) => {
      const t = paramTys[i] ?? T.unk;
      const te = argTes[i] ?? this.expr(a, t);
      return this.coerce(te, t, a);
    });
    if (unresolved) return mk(T.unk, { k: "err" }, argDeps);
    if (this.dry) {
      return mk(
        ret,
        { k: "err" },
        tps !== undefined && argDeps.length > 0 && isTypeParamReturn(decl) ? argDeps : undefined,
      );
    }
    if (tyArgs.some((t) => t.k === "unk")) return mk(T.unk, { k: "err" });
    const inst = this.instance(decl, tyArgs, e);
    return mk(ret, { k: "call", inst, args });
  }

  coreCall(e: ts.CallExpression, name: string, expected?: Ty): TE {
    const loc = this.loc(e);
    const arg0 = e.arguments[0];
    const convTarget = CONVERSIONS[name];
    if (convTarget !== undefined) {
      if (arg0 === undefined) return mk(convTarget, { k: "err" });
      const a = this.expr(arg0);
      if (
        a.ty.k !== "unk" &&
        !isNumericTy(a.ty) &&
        !isLitTy(a.ty) &&
        a.ty.k !== "enum" &&
        a.ty.k !== "lits"
      ) {
        return this.err(arg0, "TSL2003", `${tyName(a.ty)} doesn't convert to a number`);
      }
      return mk(convTarget, { k: "builtin", name, args: [a], loc });
    }
    switch (name) {
      case "idiv": {
        const b0 = e.arguments[1];
        if (arg0 === undefined || b0 === undefined) return mk(T.unk, { k: "err" });
        let a = this.expr(arg0, expected);
        let b = this.expr(b0, expected);
        if (isLitTy(a.ty) && isLitTy(b.ty) && expected !== undefined && known(expected)) {
          a = this.coerce(a, expected, arg0);
          b = this.coerce(b, expected, b0);
        }
        const p = this.peer(e, a, b);
        if (p.ty.k === "unk") return mk(T.unk, { k: "err" }, p.deps);
        if (p.ty.k !== "int") {
          if (isLitTy(p.ty)) return this.err(e, "TSL2001", "no evidence for this idiv's type");
          return this.err(e, "TSL2003", "idiv is for number-backed integers");
        }
        return mk(p.ty, { k: "arith", op: "idiv", a: p.a, b: p.b, wrap: false, loc }, p.deps);
      }
      case "trap": {
        if (arg0 === undefined) return mk(T.never, { k: "err" });
        if (this.bareTrapCode(arg0, "trap")) return mk(T.never, { k: "err" });
        const c = this.trapCode(arg0);
        return mk(T.never, { k: "builtin", name, args: [c], loc });
      }
      case "assert": {
        const code = e.arguments[1];
        if (arg0 === undefined || code === undefined) return mk(T.void, { k: "err" });
        // Its code is a trap code like trap's, so it's named too (TSL1026, 3.10, D72).
        if (this.bareTrapCode(code, "assert")) return mk(T.void, { k: "err" });
        const c = this.condition(arg0);
        const k = this.trapCode(code);
        return mk(T.void, { k: "builtin", name, args: [c, k], loc });
      }
      case "panic":
      case "log":
        return this.logCall(e, name);
      case "lit":
        return this.err(e, "TSL9001", "lit is only for top-level constants in M1");
      case "tail":
        return this.err(e, "TSL1024", "tail() declares a class's last field: it isn't a value");
      default:
        return this.err(e, "TSL9001", `${name} is not in M1's subset`);
    }
  }

  logCall(e: ts.CallExpression, name: string): TE {
    const loc = this.loc(e);
    const ty = name === "panic" ? T.never : T.void;
    const arg = e.arguments[0];
    if (arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      return mk(ty, { k: "builtin", name, args: [], loc, text: arg.text });
    }
    if (arg !== undefined && ts.isTemplateExpression(arg)) {
      const holes: TE[] = [];
      for (const span of arg.templateSpans) {
        const h = this.expr(span.expression);
        const k = h.ty.k;
        if (
          k === "float" ||
          k === "big" ||
          k === "rec" ||
          k === "union" ||
          k === "arr" ||
          k === "fn"
        ) {
          this.err(
            span.expression,
            "TSL1007",
            "template holes are integers, bools, enums or literal unions",
          );
        }
        holes.push(h);
      }
      return mk(ty, { k: "builtin", name, args: holes, loc, text: arg.head.text });
    }
    return this.err(e, "TSL1007", `${name} takes a string literal or a template literal`);
  }

  methodCall(e: ts.CallExpression, callee: ts.PropertyAccessExpression, expected?: Ty): TE {
    const leftSym = ts.isIdentifier(callee.expression)
      ? this.symbolOf(callee.expression)
      : undefined;
    const method = callee.name.text;
    if (leftSym !== undefined && this.isLibSymbol(leftSym)) {
      if (leftSym.name === "Math") return this.mathCall(e, method, expected);
      if (leftSym.name === "BigInt" && (method === "asUintN" || method === "asIntN")) {
        return this.bigWrap(e, method);
      }
      return this.err(e, "TSL1006", `${leftSym.name}.${method} is not in the allowed surface`);
    }
    if (leftSym !== undefined && this.isCoreSymbol(leftSym)) {
      return this.err(e, "TSL9001", "not in M1's subset");
    }
    return this.err(e, "TSL9001", `the .${method} method is not implemented in M1`);
  }

  bigWrap(e: ts.CallExpression, method: "asUintN" | "asIntN"): TE {
    const bits = e.arguments[0];
    const value = e.arguments[1];
    if (bits === undefined || value === undefined) return mk(T.unk, { k: "err" });
    if (this.fold(bits) !== 64)
      return this.err(bits, "TSL9001", "only the 64-bit forms are allowed");
    const ty = method === "asUintN" ? T.u64 : T.i64;
    const v = this.expr(value, ty, true);
    if (v.k === "lit" && typeof v.value === "bigint" && v.ty.k === "lit-big") {
      const folded =
        method === "asUintN" ? BigInt.asUintN(64, v.value) : BigInt.asIntN(64, v.value);
      return mk(ty, { k: "lit", value: folded });
    }
    if (v.ty.k === "unk") return mk(ty, { k: "err" }, v.deps);
    if (v.ty.k !== "big") return this.err(value, "TSL2003", "BigInt.asUintN takes a u64 or i64");
    return mk(ty, { k: "builtin", name: method, args: [v], loc: this.loc(e) }, v.deps);
  }

  floatArg(node: ts.Expression): TE {
    const a = this.expr(node, T.f64);
    if (a.ty.k === "unk") return a;
    if (a.ty.k === "lit-num") return this.coerce(a, T.f64, node);
    if (a.ty.k === "float") return a.ty.name === "f64" ? a : mk(T.f64, { k: "conv", val: a });
    return this.err(
      node,
      "TSL2003",
      `this Math function takes a float, not ${tyName(a.ty)}: use toF64`,
    );
  }

  mathCall(e: ts.CallExpression, method: string, expected?: Ty): TE {
    const loc = this.loc(e);
    const name = `Math.${method}`;
    const a0 = e.arguments[0];
    const a1 = e.arguments[1];
    if (a0 === undefined) return mk(T.unk, { k: "err" });
    switch (method) {
      case "imul": {
        if (a1 === undefined) return mk(T.i32, { k: "err" });
        const a = this.expr(a0);
        const b = this.expr(a1);
        for (const [t, n] of [
          [a, a0],
          [b, a1],
        ] as const) {
          if (t.ty.k === "float") return this.err(n, "TSL2003", "Math.imul takes integers");
        }
        const args = [this.bitOperand(a, a0), this.bitOperand(b, a1)];
        return mk(T.i32, { k: "builtin", name, args, loc });
      }
      case "clz32": {
        const a = this.expr(a0);
        if (a.ty.k === "float") return this.err(a0, "TSL2003", "Math.clz32 takes an integer");
        const te = mk(T.u8, { k: "builtin", name, args: [this.bitOperand(a, a0)], loc });
        return te;
      }
      case "fround": {
        const v = this.floatArg(a0);
        return mk(T.f32, { k: "builtin", name, args: [v], loc });
      }
      case "floor":
      case "ceil":
      case "trunc":
      case "sqrt": {
        const v = this.floatArg(a0);
        return mk(T.f64, { k: "builtin", name, args: [v], loc });
      }
      case "abs": {
        let a = this.expr(a0, expected);
        if (a.ty.k === "unk") return mk(T.unk, { k: "err" }, a.deps);
        if (a.ty.k === "lit-num") {
          a = this.coerce(a, expected !== undefined && known(expected) ? expected : T.f64, a0);
        }
        if (a.ty.k === "float") {
          const f = a.ty.name === "f64" ? a : mk(T.f64, { k: "conv", val: a });
          return mk(T.f64, { k: "builtin", name, args: [f], loc });
        }
        if (a.ty.k === "int") return mk(a.ty, { k: "builtin", name, args: [a], loc }, a.deps);
        return this.err(a0, "TSL2003", "Math.abs takes a number");
      }
      case "min":
      case "max": {
        if (a1 === undefined || e.arguments.length !== 2) {
          return this.err(e, "TSL9001", `Math.${method} takes exactly two arguments in M1`);
        }
        let a = this.expr(a0, expected);
        let b = this.expr(a1, expected);
        if (isLitTy(a.ty) && isLitTy(b.ty)) {
          const t = expected !== undefined && known(expected) ? expected : T.f64;
          a = this.coerce(a, t, a0);
          b = this.coerce(b, t, a1);
        }
        const p = this.peer(e, a, b);
        if (p.ty.k === "unk") return mk(T.unk, { k: "err" }, p.deps);
        if (p.ty.k === "float") {
          const fa = tyKey(p.a.ty) === "f64" ? p.a : mk(T.f64, { k: "conv", val: p.a });
          const fb = tyKey(p.b.ty) === "f64" ? p.b : mk(T.f64, { k: "conv", val: p.b });
          return mk(T.f64, { k: "builtin", name, args: [fa, fb], loc }, p.deps);
        }
        if (p.ty.k === "int")
          return mk(p.ty, { k: "builtin", name, args: [p.a, p.b], loc }, p.deps);
        return this.err(e, "TSL2003", `Math.${method} takes numbers`);
      }
      default:
        return this.err(e, "TSL1006", `${name} is not in the allowed surface`);
    }
  }
}

function isTypeParamReturn(decl: FnDecl): boolean {
  return decl.type !== undefined && ts.isTypeReferenceNode(decl.type);
}

/** The side of a binary expression a diagnostic about a literal operand should point at. */
function litNode(node: ts.Node, side: 0 | 1): ts.Node {
  if (ts.isBinaryExpression(node)) return side === 0 ? node.left : node.right;
  if (ts.isCallExpression(node)) return node.arguments[side] ?? node;
  return node;
}

function inRange(v: number, name: IntName): boolean {
  const [lo, hi] = INT_RANGE[name];
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function foldNumber(op: ts.SyntaxKind, a: number, b: number): number | null {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return a + b;
    case ts.SyntaxKind.MinusToken:
      return a - b;
    case ts.SyntaxKind.AsteriskToken:
      return a * b;
    case ts.SyntaxKind.SlashToken:
      return a / b;
    case ts.SyntaxKind.PercentToken:
      return a % b;
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      // Only exact integer powers: other results can differ by engine.
      if (!Number.isInteger(a) || !Number.isInteger(b) || b < 0) return null;
      const v = a ** b;
      return Math.abs(v) <= 9007199254740991 ? v : null;
    }
    case ts.SyntaxKind.AmpersandToken:
      return a & b;
    case ts.SyntaxKind.BarToken:
      return a | b;
    case ts.SyntaxKind.CaretToken:
      return a ^ b;
    case ts.SyntaxKind.LessThanLessThanToken:
      return a << b;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return a >> b;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return a >>> b;
    default:
      return null;
  }
}

function foldBig(op: ts.SyntaxKind, a: bigint, b: bigint): bigint | null {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return a + b;
    case ts.SyntaxKind.MinusToken:
      return a - b;
    case ts.SyntaxKind.AsteriskToken:
      return a * b;
    case ts.SyntaxKind.SlashToken:
      return b === 0n ? null : a / b;
    case ts.SyntaxKind.PercentToken:
      return b === 0n ? null : a % b;
    case ts.SyntaxKind.AmpersandToken:
      return a & b;
    case ts.SyntaxKind.BarToken:
      return a | b;
    case ts.SyntaxKind.CaretToken:
      return a ^ b;
    case ts.SyntaxKind.LessThanLessThanToken:
      return b >= 0n && b <= 4096n ? a << b : null;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return b >= 0n && b <= 4096n ? a >> b : null;
    default:
      return null;
  }
}

export function packElems(elem: ElemName, values: (number | bigint)[]): Uint8Array {
  const size = elemSize(elem);
  const bytes = new Uint8Array(size * values.length);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => {
    const at = i * size;
    switch (elem) {
      case "u8":
      case "i8":
        view.setUint8(at, Number(v) & 0xff);
        break;
      case "u16":
      case "i16":
        view.setUint16(at, Number(v) & 0xffff, true);
        break;
      case "u32":
      case "i32":
      case "usize":
        view.setUint32(at, Number(v) >>> 0, true);
        break;
      case "f32":
        view.setFloat32(at, Number(v), true);
        break;
      case "f64":
        view.setFloat64(at, Number(v), true);
        break;
      case "u64":
      case "i64":
        view.setBigUint64(at, BigInt.asUintN(64, v as bigint), true);
        break;
    }
  });
  return bytes;
}
