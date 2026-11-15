// Walks the typed tree of native TSL: closure capture analysis and escape checking both read it this way.
import type { Stmt, TE } from "./types.ts";

export function teChildren(te: TE): TE[] {
  switch (te.k) {
    case "tableget":
      return [te.idx];
    case "index":
    case "optindex":
      return [te.arr, te.idx];
    case "len":
      return [te.arr];
    case "arith":
    case "farith":
    case "bigshift":
    case "bit":
    case "cmp":
    case "logic":
      return [te.a, te.b];
    case "bitnot":
    case "neg":
    case "not":
      return [te.a];
    case "cond":
      return [te.c, te.a, te.b];
    case "setvar":
    case "setglobal":
      return [te.val];
    case "setindex":
      return [te.arr, te.idx, te.val];
    case "seq":
      return [...te.items, te.result];
    case "call":
    case "builtin":
      return te.args;
    case "callind":
      return [te.fn, ...te.args];
    case "record":
    case "ulit":
      return te.fields.map((f) => f.val);
    case "field":
      return [te.obj];
    case "conv":
    case "isundef":
    case "optpayload":
    case "nonnull":
    case "chkref":
      return [te.val];
    case "tuple":
      return te.items;
    case "ofield":
      return [te.obj];
    case "osetfield":
      return [te.obj, te.val];
    case "callclo":
      return [te.clo, ...te.args];
    case "new":
      return [
        ...(te.tail !== undefined ? [te.tail] : []),
        ...(te.into !== null ? [te.into.obj] : []),
        ...te.args,
        ...te.init.map((i) => i.val),
      ];
    default:
      return [];
  }
}

export function stmtExprs(s: Stmt): TE[] {
  switch (s.k) {
    case "let":
      return s.init !== null ? [s.init] : [];
    case "expr":
      return [s.e];
    case "if":
    case "while":
    case "do":
      return [s.c];
    case "for":
      return [...(s.c !== null ? [s.c] : []), ...s.step];
    case "forof":
      return [s.arr];
    case "switch":
      return [s.val];
    case "return":
      return s.val !== null ? [s.val] : [];
    case "using":
      return s.dispose !== null ? [s.dispose] : [];
    default:
      return [];
  }
}

export function stmtBodies(s: Stmt): Stmt[][] {
  switch (s.k) {
    case "if":
      return s.b !== null ? [s.a, s.b] : [s.a];
    case "while":
    case "do":
    case "forof":
    case "block":
      return [s.body];
    case "for":
      return [s.init, s.body];
    case "switch":
      return s.clauses.map((c) => c.body);
    case "label":
      return [[s.body]];
    default:
      return [];
  }
}

/** Every expression in these statements, children first. Closure bodies are walked when `intoClosures`. */
export function walkTE(list: Stmt[], f: (te: TE) => void, intoClosures: boolean): void {
  const visit = (te: TE): void => {
    for (const c of teChildren(te)) visit(c);
    if (te.k === "closure" && intoClosures) walkTE(te.inst.body, f, true);
    f(te);
  };
  for (const s of list) {
    for (const e of stmtExprs(s)) visit(e);
    for (const b of stmtBodies(s)) walkTE(b, f, intoClosures);
  }
}

export function walkStmts(list: Stmt[], f: (s: Stmt) => void): void {
  for (const s of list) {
    f(s);
    for (const b of stmtBodies(s)) walkStmts(b, f);
  }
}
