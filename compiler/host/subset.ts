// The syntactic half of the TSL checker: what's banned wherever it appears (SPEC 3.6).
// TSL9001 marks constructs TSL allows in general but that M1's subset doesn't implement yet.
import ts from "typescript";
import type { DiagSink } from "./diag.ts";

const TYPED_ARRAYS = new Set([
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigUint64Array",
  "BigInt64Array",
]);
const ALLOWED_GLOBALS = new Set([...TYPED_ARRAYS, "Math", "BigInt", "NaN", "Infinity"]);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function strip(e: ts.Expression): ts.Expression {
  let cur = e;
  for (let guard = 0; guard < 256 && ts.isParenthesizedExpression(cur); guard++)
    cur = cur.expression;
  return cur;
}

export function isTopLevelConst(node: ts.Node): boolean {
  const p = node.parent;
  return (
    ts.isVariableDeclaration(p) &&
    p.initializer === node &&
    ts.isVariableDeclarationList(p.parent) &&
    (p.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(p.parent.parent) &&
    ts.isSourceFile(p.parent.parent.parent)
  );
}

export interface SubsetOptions {
  native: boolean; // classes, closures and references are in play (SPEC 3.4, 3.5)
  unsafeAllowed: boolean; // this module is listed under "unsafeModules" in its tsl.json (SPEC 3.8)
  /** An `rc` package's module, before tslc expands it (D74): `WeakRef` is sugar for @tsl/gc's `Weak` there. */
  rc?: boolean;
}

/** Calls that are descriptors rather than memory operations, so they need no SAFETY comment. */
const SAFE_UNSAFE_EXPORTS = new Set([
  "ref",
  "inlineOf",
  "elemSize",
  "checkLive",
  "countedExactly",
  "cycleGroup",
  "cycleGroupOf",
  "cyclesLinked",
]);

function fromUnsafe(sym: ts.Symbol | undefined): boolean {
  const name = sym?.declarations?.[0]?.getSourceFile().fileName ?? "";
  return name.endsWith("packages/tsl-unsafe/index.ts");
}

export function checkSubset(
  program: ts.Program,
  sf: ts.SourceFile,
  sink: DiagSink,
  noFloat: boolean,
  opts: SubsetOptions = { native: false, unsafeAllowed: false },
): void {
  const native = opts.native;
  const checker = program.getTypeChecker();
  const err = (node: ts.Node, code: string, msg: string): void => {
    sink.at(sf, node, code, msg);
  };

  const isLibSymbol = (sym: ts.Symbol | undefined): boolean => {
    const decl = sym?.declarations?.[0];
    return decl !== undefined && program.isSourceFileDefaultLibrary(decl.getSourceFile());
  };

  for (const st of sf.statements) checkTopLevel(st);

  function checkTopLevel(st: ts.Statement): void {
    if (ts.isImportDeclaration(st)) {
      const spec = st.moduleSpecifier;
      if (!native) {
        if (!ts.isStringLiteral(spec) || spec.text !== "@tsl/core") {
          err(st, "TSL9001", "M1 compiles one module: only imports from @tsl/core are implemented");
        }
        return;
      }
      const name = ts.isStringLiteral(spec) ? spec.text : "";
      if ((name === "@tsl/unsafe" || name === "@tsl/arch-aarch64") && !opts.unsafeAllowed) {
        err(st, "TSL5001", `${name} is only for modules listed under "unsafeModules" in tsl.json`);
      } else if (!name.startsWith(".") && !name.startsWith("@tsl/")) {
        err(st, "TSL9001", `${name} is not a TSL module`);
      }
      return;
    }
    if (native && ts.isExpressionStatement(st)) {
      // assertSize is the one call allowed at the top level: the compiler evaluates it (SPEC 3.4).
      visit(st.expression);
      return;
    }
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isVariableStatement(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isModuleDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isEmptyStatement(st)
    ) {
      visit(st);
      return;
    }
    if (ts.isExportAssignment(st)) {
      err(st, "TSL9001", "default exports are not implemented");
      return;
    }
    err(st, "TSL1010", "no run-time module init: only declarations are allowed at the top level");
  }

  function visit(node: ts.Node): void {
    if (ts.canHaveDecorators(node) && ts.getDecorators(node)?.length) {
      err(ts.getDecorators(node)![0]!, "TSL1011", "decorators are banned");
    }
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
      err(node, "TSL1009", "async is banned: it needs a runtime");
      return;
    }
    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression: {
        const c = node as ts.ClassLikeDeclaration;
        // `implements` is only a check: a dispatch interface's classes come from flow, not from it (3.4, D70).
        const ext = c.heritageClauses?.find((h) => h.token !== ts.SyntaxKind.ImplementsKeyword);
        if (ext !== undefined) {
          err(ext, "TSL1001", "inheritance is banned: no dynamic dispatch");
        } else if (hasModifier(c, ts.SyntaxKind.AbstractKeyword)) {
          err(c, "TSL1001", "abstract is banned: no dynamic dispatch");
        } else if (native) {
          ts.forEachChild(c, visit);
        } else err(c, "TSL9001", "classes are not in M1's subset (M3)");
        return;
      }
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
        err(node, "TSL1003", "any and unknown are banned: types must be exact");
        return;
      case ts.SyntaxKind.AsExpression: {
        const a = node as ts.AsExpression;
        if (a.type.kind !== ts.SyntaxKind.NumberKeyword) {
          err(node, "TSL1003", "`as` is banned, except numeric-to-number");
          return;
        }
        visit(a.expression);
        return;
      }
      case ts.SyntaxKind.TypeAssertionExpression:
      case ts.SyntaxKind.SatisfiesExpression:
        err(node, "TSL1003", "type assertions are banned");
        return;
      case ts.SyntaxKind.ThrowStatement:
      case ts.SyntaxKind.TryStatement:
        err(node, "TSL1004", "exceptions are banned: use Result, trap(code) or panic(msg)");
        return;
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.DeleteExpression:
      case ts.SyntaxKind.WithStatement:
        err(node, "TSL1009", "needs a runtime, or defeats static compilation");
        return;
      case ts.SyntaxKind.VariableDeclarationList: {
        const flags = (node as ts.VariableDeclarationList).flags;
        if ((flags & ts.NodeFlags.BlockScoped) === 0) {
          err(node, "TSL1009", "var is banned: use const or let");
          return;
        }
        const scoped = flags & ts.NodeFlags.BlockScoped;
        if (scoped === ts.NodeFlags.AwaitUsing) {
          err(node, "TSL1009", "await using needs a runtime");
          return;
        }
        if (scoped === ts.NodeFlags.Using && !native) {
          err(node, "TSL9001", "using is not in M1's subset (M3)");
          return;
        }
        break;
      }
      case ts.SyntaxKind.ModuleDeclaration:
        err(node, "TSL1011", "namespaces are banned");
        return;
      case ts.SyntaxKind.EnumDeclaration: {
        const e = node as ts.EnumDeclaration;
        if (hasModifier(e, ts.SyntaxKind.ConstKeyword)) {
          err(e, "TSL1011", "const enum is banned");
          return;
        }
        for (const m of e.members) {
          const init = m.initializer;
          if (init === undefined) {
            err(m, "TSL1011", "enum members need explicit numeric constants");
          } else if (ts.isStringLiteralLike(init)) {
            err(m, "TSL1011", "string enums are banned");
          } else visit(init);
        }
        return;
      }
      case ts.SyntaxKind.PrivateIdentifier:
        err(node, "TSL1011", "#private is banned");
        return;
      case ts.SyntaxKind.TaggedTemplateExpression:
        err(node, "TSL1007", "no run-time strings");
        return;
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
        const p = node.parent;
        const inLog =
          ts.isCallExpression(p) &&
          ts.isIdentifier(p.expression) &&
          (p.expression.text === "log" || p.expression.text === "panic");
        if (!inLog) {
          err(node, "TSL1007", "template literals only as the direct argument of log or panic");
          return;
        }
        break;
      }
      case ts.SyntaxKind.StringKeyword:
        err(node, "TSL1007", "no run-time strings: use lit or Uint8Array");
        return;
      case ts.SyntaxKind.NullKeyword:
        if (native) return; // tslc's types say whether this one is on a reference
        err(node, "TSL1008", "null only applies to references, and M1 has none");
        return;
      case ts.SyntaxKind.UndefinedKeyword:
        // tslc's types say whether `T | undefined` is a reference or a function's nullable scalar (SPEC 3.3, rule 12).
        if (native && node.parent !== undefined && ts.isUnionTypeNode(node.parent)) return;
        err(node, "TSL1008", "undefined is banned");
        return;
      case ts.SyntaxKind.NumberKeyword:
        if (isInConstraint(node)) return;
        err(node, "TSL2005", "a plain number has no width: say which, such as u32 or f64");
        return;
      case ts.SyntaxKind.BigIntKeyword:
        if (isInConstraint(node)) return;
        err(node, "TSL2005", "a plain bigint has no width: use u64 or i64");
        return;
      case ts.SyntaxKind.ArrayType:
      case ts.SyntaxKind.TupleType:
        if (!isTableAnnotation(node)) {
          err(node, "TSL1006", "plain arrays are banned: use a typed array");
        }
        return;
      case ts.SyntaxKind.ArrayLiteralExpression: {
        if (!isAllowedArrayLiteral(node as ts.ArrayLiteralExpression)) {
          err(node, "TSL1006", "plain arrays are banned: use a typed array");
          return;
        }
        break;
      }
      case ts.SyntaxKind.NewExpression: {
        const n = node as ts.NewExpression;
        const name = ts.isIdentifier(n.expression) ? n.expression.text : "";
        if (TYPED_ARRAYS.has(name) && isLibSymbol(checker.getSymbolAtLocation(n.expression))) {
          if (!isTopLevelConst(n)) {
            err(
              n,
              "TSL1001",
              "new of a typed array inside a function is banned: no hidden allocation",
            );
            return;
          }
        }
        break;
      }
      case ts.SyntaxKind.RegularExpressionLiteral:
        err(node, "TSL1006", "regular expressions need a runtime");
        return;
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.FunctionDeclaration: {
        const f = node as ts.FunctionLikeDeclaration;
        if ((f as ts.FunctionDeclaration).asteriskToken !== undefined) {
          err(node, "TSL1009", "generators are banned: they need a runtime");
          return;
        }
        const topDecl = ts.isFunctionDeclaration(f) && ts.isSourceFile(f.parent);
        const topConst = ts.isArrowFunction(f) && isTopLevelConst(f);
        if (!topDecl && !topConst) {
          if (!native || ts.isFunctionExpression(f)) {
            err(node, "TSL9001", "closures and nested functions are not in M1's subset (M3)");
            return;
          }
          // A nested closure's types may come from where it's passed, so only a declaration needs them.
          if (ts.isFunctionDeclaration(f)) checkSignature(f);
          break;
        }
        checkSignature(f);
        break;
      }
      case ts.SyntaxKind.ThisKeyword:
        if (native) return;
        err(node, "TSL9001", "`this` needs classes, which are not in M1's subset (M3)");
        return;
      case ts.SyntaxKind.TypeOfExpression:
      case ts.SyntaxKind.VoidExpression:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.SpreadElement:
      case ts.SyntaxKind.ArrayBindingPattern:
      case ts.SyntaxKind.TypeQuery:
        err(node, "TSL9001", "not in M1's subset");
        return;
      case ts.SyntaxKind.NonNullExpression:
        break;
      case ts.SyntaxKind.VariableDeclaration: {
        const d = node as ts.VariableDeclaration;
        const init = d.initializer !== undefined ? strip(d.initializer) : undefined;
        if (d.type === undefined && init !== undefined) {
          if (ts.isStringLiteral(init)) {
            err(init, "TSL1007", "no run-time strings: a string needs a literal-union annotation");
            return;
          }
          if (ts.isObjectLiteralExpression(init)) {
            err(init, "TSL1005", "an object literal needs a declared value-record type");
            return;
          }
        }
        break;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const b = node as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (
          (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) &&
          (ts.isStringLiteralLike(strip(b.left)) || ts.isStringLiteralLike(strip(b.right)))
        ) {
          err(node, "TSL1007", "no run-time strings: concatenation is banned");
          return;
        }
        if (
          !native &&
          (op === ts.SyntaxKind.QuestionQuestionToken ||
            op === ts.SyntaxKind.QuestionQuestionEqualsToken)
        ) {
          err(node, "TSL1008", "?? applies to references, and M1 has none");
          return;
        }
        if (op === ts.SyntaxKind.InstanceOfKeyword || op === ts.SyntaxKind.InKeyword) {
          err(node, "TSL9001", "not in M1's subset");
          return;
        }
        break;
      }
      case ts.SyntaxKind.CallExpression: {
        const c = node as ts.CallExpression;
        if (c.expression.kind === ts.SyntaxKind.ImportKeyword) {
          err(node, "TSL1009", "dynamic import is banned");
          return;
        }
        if (!native && c.questionDotToken !== undefined) {
          err(node, "TSL1008", "?. applies to references, and M1 has none");
          return;
        }
        if (ts.isIdentifier(c.expression) && c.expression.text === "eval") {
          err(node, "TSL1009", "eval is banned");
          return;
        }
        if (native && opts.unsafeAllowed) checkSafetyComment(c);
        break;
      }
      case ts.SyntaxKind.PropertyAccessExpression:
        if (!native && (node as ts.PropertyAccessExpression).questionDotToken !== undefined) {
          err(node, "TSL1008", "?. applies to references, and M1 has none");
          return;
        }
        break;
      case ts.SyntaxKind.TypeReference: {
        const r = node as ts.TypeReferenceNode;
        const name = ts.isIdentifier(r.typeName) ? r.typeName.text : "";
        const sym = checker.getSymbolAtLocation(r.typeName);
        if (
          isLibSymbol(sym) &&
          !TYPED_ARRAYS.has(name) &&
          !(opts.rc === true && name === "WeakRef")
        ) {
          err(node, "TSL1006", `${name} needs a runtime or hidden allocation`);
          return;
        }
        if (name === "isize") {
          err(node, "TSL9001", "isize is not in M1's subset");
          return;
        }
        if (noFloat && (name === "f32" || name === "f64" || name.startsWith("Float"))) {
          err(node, "TSL1013", "floats are banned in a noFloat package");
          return;
        }
        // Type arguments still get visited, so `Foo<any>` is caught.
        break;
      }
      case ts.SyntaxKind.NumericLiteral:
        if (noFloat && !Number.isInteger(Number((node as ts.NumericLiteral).text))) {
          err(node, "TSL1013", "floats are banned in a noFloat package");
          return;
        }
        break;
      case ts.SyntaxKind.Identifier: {
        const id = node as ts.Identifier;
        if (isDeclarationName(id)) break;
        if (id.text === "undefined") {
          if (testsNullableIndex(id)) break;
          // What a nullable result gives back, and what one is tested against: tslc's types say which (SPEC 3.3, rule 12).
          if (native && givesOrTestsUndefined(id)) break;
          err(node, "TSL1008", "undefined is banned");
          return;
        }
        if (id.text === "arguments") {
          err(node, "TSL1006", "arguments is banned");
          return;
        }
        // Symbol.dispose is the one thing Symbol is for (SPEC 3.6, TSL1006).
        if (
          native &&
          id.text === "Symbol" &&
          ts.isPropertyAccessExpression(id.parent) &&
          id.parent.name.text === "dispose"
        ) {
          break;
        }
        const sym = checker.getSymbolAtLocation(id);
        if (
          isLibSymbol(sym) &&
          !ALLOWED_GLOBALS.has(id.text) &&
          !(opts.rc === true && id.text === "WeakRef")
        ) {
          err(node, "TSL1006", `${id.text} needs a runtime or hidden allocation`);
          return;
        }
        break;
      }
      case ts.SyntaxKind.Parameter: {
        const p = node as ts.ParameterDeclaration;
        if (p.questionToken !== undefined || p.initializer !== undefined) {
          err(node, "TSL1008", "optional and default parameters rely on undefined");
          return;
        }
        if (p.dotDotDotToken !== undefined) {
          err(node, "TSL9001", "rest parameters are not in M1's subset");
          return;
        }
        break;
      }
      case ts.SyntaxKind.PropertySignature:
        if ((node as ts.PropertySignature).questionToken !== undefined) {
          err(node, "TSL1008", "optional fields rely on undefined");
          return;
        }
        break;
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
        if (native && ts.isClassLike(node.parent)) {
          if ((node as ts.MethodDeclaration).asteriskToken !== undefined) {
            err(node, "TSL1009", "generators are banned: they need a runtime");
            return;
          }
          break;
        }
        if (ts.isObjectLiteralExpression(node.parent)) {
          err(
            node,
            "TSL1005",
            "an object literal's methods have no class to call them by: write a class with them (3.4, D70)",
          );
          return;
        }
        err(node, "TSL1005", "object types hold values only");
        return;
      case ts.SyntaxKind.MethodSignature: {
        // A dispatch interface (3.4, D70): methods only, none generic, called through by class id. Its classes come from
        // the program's flow, so what would make that set unknowable, or need more than a direct call per class, is out.
        const ms = node as ts.MethodSignature;
        const p = ms.parent;
        if (native && ts.isInterfaceDeclaration(p) && p.members.every(ts.isMethodSignature)) {
          if (p.members[0] === ms && p.typeParameters !== undefined) {
            err(
              p.typeParameters[0]!,
              "TSL1025",
              "a dispatch interface isn't generic: each instance would have classes of its own",
            );
          }
          if (p.members[0] === ms && p.heritageClauses !== undefined) {
            err(
              p.heritageClauses[0]!,
              "TSL1025",
              "a dispatch interface doesn't extend another: say all its methods in it",
            );
          }
          if (ms.typeParameters !== undefined) {
            err(
              node,
              "TSL1025",
              "a dispatch interface's methods aren't generic: each class would need every instance",
            );
            return;
          }
          if (ms.questionToken !== undefined) {
            err(
              node,
              "TSL1025",
              "a dispatch interface's methods aren't optional: every class has each one",
            );
            return;
          }
          for (const q of ms.parameters) {
            if (
              q.type !== undefined &&
              (ts.isFunctionTypeNode(q.type) || ts.isConstructorTypeNode(q.type))
            ) {
              err(
                q,
                "TSL1025",
                "a dispatch interface's method doesn't take a function, yet: each class's arm would need it",
              );
              return;
            }
          }
          break;
        }
        err(node, "TSL1005", "object types hold values only");
        return;
      }
      case ts.SyntaxKind.PropertyDeclaration:
        if ((node as ts.PropertyDeclaration).questionToken !== undefined) {
          err(node, "TSL1008", "optional fields rely on undefined");
          return;
        }
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  }

  /** TSL5002: an unsafe primitive's call has a `// SAFETY:` comment before it or before something around it. */
  function checkSafetyComment(c: ts.CallExpression): void {
    const callee = c.expression;
    let unsafe = false;
    if (ts.isIdentifier(callee)) {
      const raw = checker.getSymbolAtLocation(callee);
      const sym =
        raw !== undefined && raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
      unsafe = fromUnsafe(sym) && !SAFE_UNSAFE_EXPORTS.has(sym?.name ?? "");
    } else if (ts.isPropertyAccessExpression(callee)) {
      // A Ptr's methods read and write memory, or make a pointer that will.
      const t = checker.getTypeAtLocation(callee.expression).getNonNullableType();
      unsafe = t.symbol?.name === "Ptr" && fromUnsafe(t.symbol);
    }
    if (!unsafe) return;
    for (let n: ts.Node = c; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
      if (!(ts.isStatement(n) || ts.isClassElement(n) || ts.isVariableDeclaration(n))) continue;
      const comments = ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? [];
      if (comments.some((r) => sf.text.slice(r.pos, r.end).startsWith("// SAFETY:"))) return;
    }
    err(
      c,
      "TSL5002",
      "this unsafe call needs a `// SAFETY:` comment before it, saying why it's sound",
    );
  }

  function checkSignature(f: ts.FunctionLikeDeclaration): void {
    for (const p of f.parameters) {
      if (p.type === undefined) err(p, "TSL2001", "every parameter is annotated");
    }
    if (f.type === undefined) {
      err(f.name ?? f, "TSL2001", "every function's return is annotated");
    }
  }

  /** a[i] === undefined, directly or through a const bound to a[i] (SPEC 3.3, rule 12). */
  function testsNullableIndex(id: ts.Identifier): boolean {
    const p = id.parent;
    if (!ts.isBinaryExpression(p)) return false;
    const op = p.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return false;
    }
    let other = p.left === id ? p.right : p.left;
    while (ts.isParenthesizedExpression(other)) other = other.expression;
    if (ts.isElementAccessExpression(other)) return true;
    if (!ts.isIdentifier(other)) return false;
    const d = checker.getSymbolAtLocation(other)?.valueDeclaration;
    return (
      d !== undefined &&
      ts.isVariableDeclaration(d) &&
      (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
      d.initializer !== undefined &&
      ts.isElementAccessExpression(d.initializer)
    );
  }

  function isDeclarationName(id: ts.Identifier): boolean {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
    if (ts.isPropertySignature(p) || ts.isPropertyAssignment(p)) return p.name === id;
    if (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) {
      return p.name === id;
    }
    if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
    if (ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isEnumMember(p)) {
      return p.name === id;
    }
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
    if (ts.isTypeParameterDeclaration(p) || ts.isQualifiedName(p)) return true;
    if (ts.isTypeReferenceNode(p)) return true;
    if (ts.isClassLike(p) || ts.isClassElement(p)) return p.name === id;
    return false;
  }

  function isInConstraint(node: ts.Node): boolean {
    let cur: ts.Node = node;
    for (let guard = 0; guard < 64; guard++) {
      const p = cur.parent;
      if (ts.isTypeParameterDeclaration(p)) return p.constraint === cur;
      if (!ts.isUnionTypeNode(p) && !ts.isParenthesizedTypeNode(p)) return false;
      cur = p;
    }
    return false;
  }

  function isTableAnnotation(node: ts.Node): boolean {
    let cur = node.parent;
    if (ts.isTypeOperatorNode(cur)) cur = cur.parent;
    return (
      ts.isVariableDeclaration(cur) &&
      ts.isVariableDeclarationList(cur.parent) &&
      ts.isVariableStatement(cur.parent.parent) &&
      ts.isSourceFile(cur.parent.parent.parent)
    );
  }

  function isAllowedArrayLiteral(a: ts.ArrayLiteralExpression): boolean {
    // A constant dispatch table, or the elements of a static typed array.
    if (isTopLevelConst(a)) return a.elements.every((e) => ts.isIdentifier(strip(e)));
    const p = a.parent;
    return ts.isNewExpression(p) && p.arguments?.[0] === a && isTopLevelConst(p);
  }
}

/** `return undefined`, or `x === undefined` and `!==`: the two places TSL proper has `undefined` as a value. */
function givesOrTestsUndefined(id: ts.Identifier): boolean {
  let at: ts.Node = id;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const p = at.parent;
  if (ts.isReturnStatement(p)) return true;
  return (
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  );
}
