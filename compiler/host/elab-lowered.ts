// @tsl/lowered (SPEC 4.5, D62, design/pipeline.md): what tslc makes of down-lowered TSL's own words. Each call becomes the
// one node of the typed tree that down-lowering has always built for it, so TS -> TSL -> tslc reaches the TIR the direct
// route reaches, and the dual-route differential (`tmk milestone pipe-a`) is a test of the printer and of this, nothing else.
// Only a package whose tsl.json says "lowered" gets here (TSL1023 in tslc.ts).
import ts from "typescript";
import type { Func, Global, TirType } from "../tir/ir.ts";
import {
  excRtFuncs,
  excRtGlobals,
  hashRtFuncs,
  memoryRtFuncs,
  memoryRtGlobals,
  RT_TRAPS,
  rtFuncs,
  rtGlobals,
  strRtFuncs,
} from "./down-rt.ts";
import { charTableGlobal, hashKeyGlobal, strLiteralGlobal } from "./down.ts";
import { oldLayout } from "./down-model.ts";
import { T, type ElemName, type MemLeaf, type TE, type TEK, type Ty } from "./types.ts";

export function isLoweredFile(name: string): boolean {
  return name.endsWith("packages/tsl-lowered/index.ts");
}

/** The leaves a value of this type takes in memory at `off`, as down-model.ts's memOf lays a field out. */
export function stdMem(t: Ty, off: number): MemLeaf[] | null {
  switch (t.k) {
    case "int":
      return [{ t: t.name === "usize" ? "ix" : "i32", off }];
    case "float":
      return t.name === "f64" ? [{ t: "f64", off }] : [{ t: "f32", off }];
    case "big":
      return [{ t: "i64", off }];
    case "bool":
      // R6: a byte, as TSL lays a `bool` out and down-model.ts's memOf now does (D36).
      return [{ t: oldLayout() ? "i32" : "i8", off }];
    case "lits":
    case "enum":
      return [{ t: "i32", off }];
    case "ref":
      return [{ t: "ptr", off }];
    case "arr":
      return [
        { t: "ptr", off },
        { t: "ix", off: off + 8 },
      ];
    case "opt": {
      // R6: a `bool` flag, then the value at its own alignment (down-model.ts's optValueOff).
      const a = oldLayout() ? 8 : Math.max(1, stdAlign(t.of));
      const inner = stdMem(t.of, off + a);
      return inner === null ? null : [{ t: oldLayout() ? "i32" : "i8", off }, ...inner];
    }
    default:
      return null;
  }
}

/** A value's alignment in memory, as memOf lays it out: a leaf's own size, a typed array's pointer 8. */
function stdAlign(t: Ty): number {
  const m = stdMem(t, 0);
  if (m === null || m.length === 0) return 1;
  const size = (x: MemLeaf): number =>
    x.t === "i8" ? 1 : x.t === "i16" ? 2 : x.t === "i32" || x.t === "f32" ? 4 : 8;
  return Math.max(...m.map(size));
}

export function memText(mem: MemLeaf[]): string {
  return mem.map((m) => `${m.t}@${m.off}`).join(",");
}

function parseMem(s: string): MemLeaf[] | null {
  if (s === "") return [];
  const out: MemLeaf[] = [];
  for (const part of s.split(",")) {
    const m = /^(i8|i32|i64|f32|f64|ptr|ix)@(-?\d+)$/.exec(part.trim());
    if (m === null) return null;
    out.push({ t: m[1] as TirType, off: Number(m[2]) });
  }
  return out;
}

const ELEMS = new Set(["u8", "i8", "u16", "i16", "u32", "i32", "f32", "f64", "u64", "i64"]);

/** A TIR leaf as the TSL type a runtime function's parameter has. */
function leafTy(t: TirType): Ty {
  switch (t) {
    case "i32":
      return T.i32;
    case "i64":
      return T.i64;
    case "f64":
      return T.f64;
    case "f32":
      return T.f32;
    case "ix":
      return T.usize;
    default:
      return { k: "ref" };
  }
}

/** What the elaborator gives this: the parts of it these calls need, so this file needn't know the class. */
export interface LoweredHost {
  expr(e: ts.Expression, expected?: Ty): TE;
  coerce(te: TE, target: Ty, node: ts.Node): TE;
  typeOf(node: ts.TypeNode): Ty;
  err(node: ts.Node, code: string, msg: string): TE;
  loc(node: ts.Node): string;
  fold(e: ts.Expression): number | bigint | null;
  bareTrapCode(x: ts.Expression, what: string): boolean;
  symbolOf(node: ts.Node): ts.Symbol | undefined;
  loweredData: Map<ts.Symbol, { name: string; size: number; global?: Global }>;
  loweredSigs: Map<string, Func>;
}

function mk(ty: Ty, node: TEK): TE {
  return { ty, ...node } as TE;
}

/** The runtime a lowered package links, by its tsl.json's "lowered" block: the same functions the direct route links. */
export function loweredRuntime(setting: LoweredSetting): {
  funcs: Func[];
  globals: Global[];
} {
  const funcs: Func[] = [...rtFuncs()];
  const globals: Global[] = [...rtGlobals()];
  if (setting.memory !== "strict") {
    funcs.push(...memoryRtFuncs());
    globals.push(...memoryRtGlobals());
  }
  if (setting.runtime.includes("str") && setting.memory !== "strict")
    funcs.push(...strRtFuncs(setting.memory));
  if (setting.runtime.includes("hash")) funcs.push(...hashRtFuncs());
  if (setting.runtime.includes("exc")) {
    funcs.push(...excRtFuncs());
    globals.push(...excRtGlobals());
  }
  return { funcs, globals };
}

export const LOWERED_TRAPS = RT_TRAPS;

export interface LoweredSetting {
  memory: "strict" | "leak" | "manual" | "rc";
  runtime: string[];
  from: string | null;
}

/** A tsl.json's "lowered" block, or why it's wrong. */
export function parseLowered(raw: unknown): LoweredSetting | string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) return '"lowered" is an object: { "memory": ... }';
  const o = raw as { memory?: unknown; runtime?: unknown; from?: unknown };
  const memory = o.memory ?? "strict";
  if (memory !== "strict" && memory !== "leak" && memory !== "manual" && memory !== "rc")
    return `"lowered.memory" is "strict", "leak", "manual" or "rc", not ${JSON.stringify(memory)}`;
  const runtime = o.runtime ?? [];
  if (!Array.isArray(runtime) || runtime.some((r) => r !== "exc" && r !== "str" && r !== "hash"))
    return '"lowered.runtime" lists what the lowering linked beyond its base: "str", "hash", "exc"';
  return {
    memory,
    runtime: runtime as string[],
    from: typeof o.from === "string" ? o.from : null,
  };
}

/** `Ref` and `Opt<T>`, the two types @tsl/lowered adds. */
export function loweredType(h: LoweredHost, name: string, node: ts.TypeReferenceNode): Ty | null {
  if (name === "Ref") return { k: "ref" };
  if (name === "Opt") {
    const a = node.typeArguments?.[0];
    return a === undefined ? T.unk : { k: "opt", of: h.typeOf(a) };
  }
  return null;
}

/** `const g = data(16)` at the top level: a block of lowered module state. */
export function loweredData(
  h: LoweredHost,
  d: ts.VariableDeclaration,
  init: ts.CallExpression,
  kind = "data",
): boolean {
  if (!ts.isIdentifier(d.name)) return false;
  const sym = h.symbolOf(d.name);
  // Static data the lowering lays out, made here by the functions it makes it with: `text("…")`, a string literal;
  // `charTable()`, the one-unit strings; `hashKey()`, the hash key's default.
  if (kind !== "data") {
    if (sym === undefined) return true;
    const a0 = init.arguments[0];
    const a1 = init.arguments[kind === "text" ? 1 : 0];
    const name = a1 !== undefined && ts.isStringLiteralLike(a1) ? a1.text : d.name.text;
    let g: Global;
    if (kind === "text") {
      if (a0 === undefined || !ts.isStringLiteralLike(a0)) {
        h.err(d, "TSL1023", "text takes a string literal");
        return true;
      }
      g = strLiteralGlobal(name, a0.text);
    } else g = kind === "charTable" ? charTableGlobal(name) : hashKeyGlobal(name);
    h.loweredData.set(sym, { name, size: g.size, global: g });
    return true;
  }
  const n = init.arguments[0] !== undefined ? h.fold(init.arguments[0]) : null;
  if (sym === undefined || typeof n !== "number") {
    h.err(d, "TSL1023", "data(size) takes a constant size");
    return true;
  }
  // Its symbol: the second argument, where the lowering's name isn't an identifier, as `g.counter` isn't.
  const a1 = init.arguments[1];
  const name = a1 !== undefined && ts.isStringLiteralLike(a1) ? a1.text : d.name.text;
  h.loweredData.set(sym, { name, size: n });
  return true;
}

export function loweredCall(h: LoweredHost, e: ts.CallExpression, name: string): TE {
  const a = e.arguments;
  const loc = h.loc(e);
  const tyArg = (i = 0): Ty => {
    const n = e.typeArguments?.[i];
    return n !== undefined ? h.typeOf(n) : T.void;
  };
  const str = (i: number): string => {
    const x = a[i];
    if (x === undefined || !ts.isStringLiteralLike(x)) {
      h.err(e, "TSL1023", `${name} takes a string literal here`);
      return "";
    }
    return x.text;
  };
  const num = (i: number): number => {
    const x = a[i];
    const v = x !== undefined ? h.fold(x) : null;
    if (typeof v !== "number") {
      h.err(e, "TSL1023", `${name} takes a constant here`);
      return 0;
    }
    return v;
  };
  const arg = (i: number, t?: Ty): TE => {
    const x = a[i]!;
    const te = h.expr(x, t);
    return t !== undefined ? h.coerce(te, t, x) : te;
  };
  const ref = (i: number): TE => arg(i, { k: "ref" });
  const usize = (i: number): TE => arg(i, T.usize);
  const rest = (from: number, types?: Ty[]): TE[] =>
    a.slice(from).map((_, j) => arg(from + j, types?.[j]));
  const mem = (i: number, t: Ty): import("./types.ts").MemLeaf[] => {
    const x = a[i]!;
    if (ts.isStringLiteralLike(x)) {
      const m = parseMem(x.text);
      if (m === null) h.err(x, "TSL1023", `not a list of leaves: ${x.text}`);
      return m ?? [];
    }
    const m = stdMem(t, num(i));
    if (m === null) h.err(e, "TSL1023", `${name} of this type needs its leaves listed`);
    return m ?? [];
  };
  const rcFlag = (i: number): { rc?: "init" | "move" } => {
    if (a[i] === undefined) return {};
    const s = str(i);
    return s === "init" || s === "move" ? { rc: s } : {};
  };
  switch (name) {
    case "rt": {
      const fn = str(0);
      const sig = h.loweredSigs.get(fn);
      const types = sig?.params.map((id) => leafTy(sig.types[id]!));
      return mk(tyArg(), { k: "rtcall", name: fn, args: rest(1, types) });
    }
    case "intrinsic":
      return mk(tyArg(), { k: "intrinsic", name: str(0), args: rest(1) });
    case "builtin": {
      if (str(0) !== "assert")
        return mk(tyArg(), { k: "builtin", name: str(0), args: rest(1), loc });
      // The lowering's bounds and narrowing checks: the code is named as trapNow's is (TSL1026, 3.10, D72), so no
      // numeric literal, bare or cast, can be one. It folds to the i32 constant the trap is keyed by.
      const x = a[2];
      if (x === undefined || h.bareTrapCode(x, "assert")) return mk(T.void, { k: "err" });
      const c = h.expr(x);
      if (c.k !== "lit" || c.ty.k !== "enum")
        return h.err(x, "TSL1026", "assert's code is named by @tsl/core's Trap (3.10)");
      return mk(tyArg(), {
        k: "builtin",
        name: "assert",
        args: [arg(1), mk(T.i32, { k: "lit", value: Number(c.value) })],
        loc,
      });
    }
    case "load": {
      const t = tyArg();
      // R14: `load<T>(base, off, "invariant")`, a word nothing writes after `new` (a class id, D73): the lowering's own
      // mark on the leaf, which the optimiser shares as the direct route's is shared
      const inv = a[2] !== undefined && ts.isStringLiteralLike(a[2]) && a[2].text === "invariant";
      const m = mem(1, t);
      return mk(t, {
        k: "fload",
        base: ref(0),
        mem: inv ? m.map((x) => ({ ...x, inv: true })) : m,
      });
    }
    case "store": {
      const t = tyArg();
      const base = ref(0);
      const m = mem(1, t);
      const val = arg(2, t);
      return mk(t, { k: "fstore", base, mem: m, val, ...rcFlag(3) });
    }
    case "allocStack": {
      const bytes = num(0);
      const zero = a[1]?.kind === ts.SyntaxKind.TrueKeyword;
      const size = a[2] !== undefined ? usize(2) : mk(T.usize, { k: "lit", value: bytes });
      return mk({ k: "ref" }, { k: "alloc", size, zero, stack: () => bytes, loc });
    }
    case "alloc": {
      const size = usize(0);
      const zero = a[1]?.kind === ts.SyntaxKind.TrueKeyword;
      const allocator = str(2);
      return mk(
        { k: "ref" },
        {
          k: "alloc",
          size,
          zero,
          stack: () => null,
          loc,
          ...(allocator !== "__alloc" ? { long: () => allocator } : {}),
        },
      );
    }
    case "elemAddr":
      return mk({ k: "ref" }, { k: "elemaddr", base: ref(0), idx: usize(1), scale: num(2) });
    case "loadElem":
    case "storeElem": {
      const t = tyArg();
      const elem = str(2);
      if (!ELEMS.has(elem)) return h.err(e, "TSL1023", `${elem} isn't an element type`);
      if (name === "loadElem")
        return mk(t, { k: "loadelem", ptr: ref(0), idx: usize(1), elem: elem as ElemName });
      return mk(t, {
        k: "storeelem",
        ptr: ref(0),
        idx: usize(1),
        elem: elem as ElemName,
        val: arg(3, t),
      });
    }
    case "addr": {
      const g = a[0]!;
      let gname: string;
      if (ts.isStringLiteralLike(g)) gname = g.text;
      else {
        const sym = h.symbolOf(g);
        const d = sym !== undefined ? h.loweredData.get(sym) : undefined;
        if (d === undefined)
          return h.err(g, "TSL1023", "addr takes a data() block or a runtime global's name");
        gname = d.name;
      }
      return mk(
        { k: "ref" },
        { k: "gaddr", name: gname, ...(a[1] !== undefined ? { off: num(1) } : {}) },
      );
    }
    case "nullRef":
      return mk({ k: "ref" }, { k: "lit", value: 0 });
    case "f2ix":
      return mk(T.usize, { k: "f2ix", val: arg(0, T.f64) });
    case "nonNull": {
      const v = arg(0);
      return mk(v.ty, { k: "nonnull", val: v, loc });
    }
    case "trapNow": {
      // A code is named (TSL1026, 3.10): `trapNow("narrow", Trap.BadCast)`, whose member folds to its constant.
      const x = a[1];
      if (x === undefined || h.bareTrapCode(x, "trapNow")) return mk(T.never, { k: "err" });
      const c = h.expr(x);
      if (c.k !== "lit" || c.ty.k !== "enum")
        return h.err(x, "TSL1023", "trapNow takes a code named by @tsl/core's Trap");
      return mk(T.never, { k: "trapnow", kind: str(0), code: Number(c.value), loc });
    }
    case "throwJs":
      return mk(T.never, { k: "throwjs", code: num(0), msg: str(1), args: rest(2), loc });
    case "wrap": {
      // Arithmetic the lowering proved in range, or JS's own wrap: unchecked, of its operands' type.
      const x = a[0];
      const b = x !== undefined && ts.isParenthesizedExpression(x) ? x.expression : x;
      if (b === undefined || !ts.isBinaryExpression(b))
        return h.err(e, "TSL1023", "wrap takes an arithmetic expression");
      const k = b.operatorToken.kind;
      const op =
        k === ts.SyntaxKind.PlusToken
          ? "add"
          : k === ts.SyntaxKind.MinusToken
            ? "sub"
            : k === ts.SyntaxKind.AsteriskToken
              ? "mul"
              : null;
      if (op === null) return h.err(e, "TSL1023", "wrap takes +, - or *");
      const l = h.expr(b.left);
      const t = l.ty.k === "lit-num" ? tyArg() : l.ty;
      const left = h.coerce(l, t, b.left);
      const right = h.coerce(h.expr(b.right, t), t, b.right);
      return mk(t, { k: "arith", op, a: left, b: right, wrap: true, loc: h.loc(b) });
    }
    case "pack":
      return mk(tyArg(), { k: "tuple", items: rest(0) });
    case "part":
      return mk(tyArg(), { k: "slice", val: arg(0), from: num(1), to: num(2) });
    case "cast": {
      const t = tyArg();
      const v = h.expr(a[0]!, t);
      if (v.ty.k === "lit-num" || v.ty.k === "lit-big") return h.coerce(v, t, a[0]!);
      return mk(t, { k: "conv", val: v });
    }
    case "isUndef":
      return mk(T.bool, {
        k: "isundef",
        val: arg(0),
        negate: a[1]?.kind === ts.SyntaxKind.TrueKeyword,
      });
    case "optPayload":
      return mk(tyArg(), { k: "optpayload", val: arg(0) });
    case "data":
    case "text":
    case "charTable":
    case "hashKey":
      return h.err(e, "TSL1023", `${name} is only a top-level const's initialiser`);
    case "unreachable":
      // Where the lowering knows a function can't fall off its end and tsc can't see it: nothing, as in the direct route,
      // where TIR's own end of function is `unreachable`.
      return mk(T.never, { k: "tuple", items: [] });
    default:
      return h.err(e, "TSL1023", `${name} isn't one of @tsl/lowered's`);
  }
}
