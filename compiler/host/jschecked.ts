// --emit=js-checked: the TSL source as plain JS, with the same checks TIR has, so V8 reproduces
// every native trap (SPEC 3.10). It reads the typed tree and doesn't go through TIR.
import {
  ARRAY_BY_ELEM,
  INT_RANGE,
  type FuncInst,
  type GlobalDef,
  type Stmt,
  type TE,
  type Ty,
  type TypedModule,
  type Var,
} from "./types.ts";

const PRELUDE = `import { TslTrap, idiv, lit, toF64, toI16, toI32, toI64, toI8, toU16, toU32, toU64, toU8, toUsize, wrapI16, wrapI32, wrapI8, wrapU16, wrapU32, wrapU8 } from "@tsl/core";
const __t = (c) => { throw new TslTrap(c); };
const __r = (v, lo, hi, c) => (v < lo || v > hi ? __t(c) : v);
const __i8 = (v, c) => __r(v, -128, 127, c);
const __i16 = (v, c) => __r(v, -32768, 32767, c);
const __i32 = (v, c) => __r(v, -2147483648, 2147483647, c);
const __u8 = (v, c) => __r(v, 0, 255, c);
const __u16 = (v, c) => __r(v, 0, 65535, c);
const __u32 = (v, c) => __r(v, 0, 4294967295, c);
const __usize = (v, c) => __r(v, 0, 9007199254740991, c);
const __u64 = (v, c) => __r(v, 0n, 18446744073709551615n, c);
const __i64 = (v, c) => __r(v, -9223372036854775808n, 9223372036854775807n, c);
const __at = (a, i) => (i >= a.length ? __t(2) : a[i]);
const __set = (a, i, v) => { if (i >= a.length) __t(2); a[i] = v; return v; };
const __rem = (a, b) => (b === 0 ? __t(3) : a % b);
const __remb = (a, b) => (b === 0n ? __t(3) : a % b);
const __divb = (a, b) => (b === 0n ? __t(3) : a / b);
const __cnt = (n) => (n < 0n ? __t(8) : n);
const __shlu = (x, n) => (x === 0n ? 0n : n >= 64n ? __t(1) : __u64(x << n, 1));
const __shls = (x, n) => (x === 0n ? 0n : n >= 64n ? __t(1) : __i64(x << n, 1));
const __shlw = (x, n) => (n >= 64n ? 0n : x << n);
const __panic = () => __t(10);
void [TslTrap, idiv, lit, toF64, toI16, toI32, toI64, toI8, toU16, toU32, toU64, toU8, toUsize, wrapI16, wrapI32, wrapI8, wrapU16, wrapU32, wrapU8];
`;

function chk(ty: Ty): string {
  if (ty.k === "int" || ty.k === "big") return `__${ty.name}`;
  throw new Error("no check for this type");
}

class JsPrinter {
  hidden = new Set<string>();

  name(v: Var): string {
    return v.name.startsWith("$") ? `__${v.name.slice(1)}_${v.id}` : `${v.name}_${v.id}`;
  }

  useVar(v: Var): string {
    const n = this.name(v);
    if (v.name.startsWith("$")) this.hidden.add(n);
    return n;
  }

  e(te: TE): string {
    switch (te.k) {
      case "raise":
        throw new Error("js-checked has no down-lowered exceptions");
      case "callclo":
        throw new Error("a closure value is native only (SPEC 4.5)");
      case "err":
        throw new Error("printing a poisoned expression");
      case "optindex":
        return `${this.e(te.arr)}[${this.e(te.idx)}]`;
      case "isundef":
        return `(${this.e(te.val)} ${te.negate ? "!==" : "==="} undefined)`;
      case "optpayload":
        return this.e(te.val);
      case "tuple":
      case "slice":
      case "gaddr":
      case "fload":
      case "fstore":
      case "elemaddr":
      case "loadelem":
      case "storeelem":
      case "alloc":
      case "rtcall":
      case "intrinsic":
      case "blockexpr":
      case "throwjs":
      case "f2ix":
      case "nonnull":
      case "ofield":
      case "osetfield":
      case "new":
      case "closure":
      case "chkref":
      case "trapnow":
        throw new Error("js-checked prints TSL, and this node is only in down-lowered code");
      case "lit":
        return litText(te.value);
      case "var":
        return this.useVar(te.v);
      case "global":
        return te.g.jsName;
      case "fnref":
        return te.inst.jsName;
      case "tableget":
        return `__at(${te.g.jsName}, ${this.e(te.idx)})`;
      case "index":
        return `__at(${this.e(te.arr)}, ${this.e(te.idx)})`;
      case "len":
        return `${this.e(te.arr)}.length`;
      case "arith":
        return this.arith(te);
      case "farith": {
        const op = { add: "+", sub: "-", mul: "*", div: "/", rem: "%" }[te.op];
        return `(${this.e(te.a)} ${op} ${this.e(te.b)})`;
      }
      case "bigshift":
        return this.bigShift(te);
      case "bit": {
        const op = { and: "&", or: "|", xor: "^", shl: "<<", shr: ">>", ushr: ">>>" }[te.op];
        return `(${this.e(te.a)} ${op} ${this.e(te.b)})`;
      }
      case "bitnot":
        return `(~${this.e(te.a)})`;
      case "neg":
        if (te.ty.k === "float") return `(-${this.e(te.a)})`;
        return `${chk(te.ty)}(-${this.e(te.a)}, 1)`;
      case "not":
        return `(!${this.e(te.a)})`;
      case "cmp": {
        const op = { eq: "===", ne: "!==", lt: "<", le: "<=", gt: ">", ge: ">=" }[te.op];
        return `(${this.e(te.a)} ${op} ${this.e(te.b)})`;
      }
      case "logic":
        return `(${this.e(te.a)} ${te.op === "and" ? "&&" : "||"} ${this.e(te.b)})`;
      case "cond":
        return `(${this.e(te.c)} ? ${this.e(te.a)} : ${this.e(te.b)})`;
      case "setvar":
        return `(${this.useVar(te.v)} = ${this.e(te.val)})`;
      case "setglobal":
        return `(${te.g.jsName} = ${this.e(te.val)})`;
      case "setindex":
        return `__set(${this.e(te.arr)}, ${this.e(te.idx)}, ${this.e(te.val)})`;
      case "seq":
        return `(${[...te.items.map((i) => this.e(i)), this.e(te.result)].join(", ")})`;
      case "call":
        return `${te.inst.jsName}(${te.args.map((a) => this.e(a)).join(", ")})`;
      case "callind":
        return `${this.e(te.fn)}(${te.args.map((a) => this.e(a)).join(", ")})`;
      case "builtin":
        return this.builtin(te);
      case "record":
      case "ulit": {
        const parts =
          te.k === "ulit" && te.ty.k === "union"
            ? [`${te.ty.tag}: ${litText(te.variant.tag)}`]
            : [];
        for (const f of te.fields) parts.push(`${f.name}: ${this.e(f.val)}`);
        return `({ ${parts.join(", ")} })`;
      }
      case "field":
        return `${this.e(te.obj)}.${te.name}`;
      case "conv":
        return this.e(te.val);
    }
  }

  arith(te: Extract<TE, { k: "arith" }>): string {
    const a = this.e(te.a);
    const b = this.e(te.b);
    const isBig = te.ty.k === "big";
    switch (te.op) {
      case "rem":
        return `${isBig ? "__remb" : "__rem"}(${a}, ${b})`;
      case "idiv":
        return isBig
          ? `${chk(te.ty)}(__divb(${a}, ${b}), 3)`
          : `${chk(te.ty)}(idiv(${a}, ${b}), 3)`;
      default: {
        const op = { add: "+", sub: "-", mul: "*" }[te.op];
        if (te.wrap) return `(${a} ${op} ${b})`;
        return `${chk(te.ty)}(${a} ${op} ${b}, 1)`;
      }
    }
  }

  bigShift(te: Extract<TE, { k: "bigshift" }>): string {
    const a = this.e(te.a);
    const counted = te.b.ty.k === "big" && te.b.ty.name === "i64";
    const n = counted ? `__cnt(${this.e(te.b)})` : this.e(te.b);
    if (te.op === "shr") return `(${a} >> ${n})`;
    if (te.wrap) return `__shlw(${a}, ${n})`;
    return `${te.ty.k === "big" && te.ty.name === "i64" ? "__shls" : "__shlu"}(${a}, ${n})`;
  }

  builtin(te: Extract<TE, { k: "builtin" }>): string {
    const args = te.args.map((a) => this.e(a));
    switch (te.name) {
      case "asUintN":
        return `BigInt.asUintN(64, ${args[0]!})`;
      case "asIntN":
        return `BigInt.asIntN(64, ${args[0]!})`;
      case "trap":
        return `__t(${args[0]!})`;
      case "assert":
        return `(${args[0]!} || __t(${args[1]!}))`;
      case "panic":
        return args.length > 0 ? `(${args.join(", ")}, __panic())` : "__panic()";
      case "log":
        return args.length > 0 ? `(${args.join(", ")}, undefined)` : "undefined";
      case "Math.abs":
        if (te.ty.k === "int" && te.ty.name.startsWith("i")) {
          return `__r(Math.abs(${args[0]!}), 0, ${INT_RANGE[te.ty.name][1]}, 1)`;
        }
        return `Math.abs(${args[0]!})`;
      default:
        return `${te.name}(${args.join(", ")})`;
    }
  }

  stmts(list: Stmt[], indent: string): string {
    return list.map((s) => this.s(s, indent)).join("");
  }

  /** The initialiser prints before the loop, in a block, so a label still sits on the loop. */
  forLoop(st: Extract<Stmt, { k: "for" }>, ind: string, label: string | null): string {
    const inner = `${ind}  `;
    const init = this.stmts(st.init, inner);
    const c = st.c !== null ? this.e(st.c) : "";
    const step = st.step.map((x) => this.e(x)).join(", ");
    const body = this.stmts(st.body, `${inner}  `);
    const head = label !== null ? `${inner}${label}:\n` : "";
    return `${ind}{\n${init}${head}${inner}for (; ${c}; ${step}) {\n${body}${inner}}\n${ind}}\n`;
  }

  s(st: Stmt, ind: string): string {
    const inner = `${ind}  `;
    switch (st.k) {
      case "try":
        throw new Error("js-checked has no down-lowered exceptions");
      case "using":
        throw new Error("js-checked has no classes yet");
      case "let":
        if (st.init === null) return `${ind}let ${this.name(st.v)};\n`;
        if (st.v.name.startsWith("$")) return `${ind}${this.useVar(st.v)} = ${this.e(st.init)};\n`;
        return `${ind}let ${this.name(st.v)} = ${this.e(st.init)};\n`;
      case "expr":
        return `${ind}${this.e(st.e)};\n`;
      case "block":
        return `${ind}{\n${this.stmts(st.body, inner)}${ind}}\n`;
      case "if": {
        const a = this.stmts(st.a, inner);
        const head = `${ind}if (${this.e(st.c)}) {\n${a}${ind}}`;
        if (st.b === null) return `${head}\n`;
        return `${head} else {\n${this.stmts(st.b, inner)}${ind}}\n`;
      }
      case "while":
        return `${ind}while (${this.e(st.c)}) {\n${this.stmts(st.body, inner)}${ind}}\n`;
      case "do":
        return `${ind}do {\n${this.stmts(st.body, inner)}${ind}} while (${this.e(st.c)});\n`;
      case "for":
        return this.forLoop(st, ind, null);
      case "forof":
        return `${ind}for (const ${this.name(st.v)} of ${this.e(st.arr)}) {\n${this.stmts(st.body, inner)}${ind}}\n`;
      case "switch": {
        let out = `${ind}switch (${this.e(st.val)}) {\n`;
        for (const c of st.clauses) {
          if (c.isDefault) out += `${inner}default:\n`;
          for (const k of c.keys) out += `${inner}case ${this.e(k)}:\n`;
          out += this.stmts(c.body, `${inner}  `);
        }
        return `${out}${ind}}\n`;
      }
      case "label":
        if (st.body.k === "for") return this.forLoop(st.body, ind, st.name);
        return `${ind}${st.name}:\n${this.s(st.body, ind)}`;
      case "break":
        return `${ind}break${st.label !== null ? ` ${st.label}` : ""};\n`;
      case "continue":
        return `${ind}continue${st.label !== null ? ` ${st.label}` : ""};\n`;
      case "return":
        return st.val !== null ? `${ind}return ${this.e(st.val)};\n` : `${ind}return;\n`;
    }
  }
}

function litText(v: number | bigint | boolean | string): string {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "(-Infinity)";
  if (Object.is(v, -0)) return "(-0)";
  return v < 0 ? `(${v})` : String(v);
}

function printGlobal(g: GlobalDef): string {
  if (g.table !== undefined) {
    return `const ${g.jsName} = [${g.table.map((i) => i.jsName).join(", ")}];\n`;
  }
  if (g.array !== undefined) {
    const a = g.array;
    if (a.text !== undefined) return `const ${g.jsName} = lit(${JSON.stringify(a.text)});\n`;
    const ctor = ARRAY_BY_ELEM[a.elem]!;
    if (a.values !== undefined) {
      return `const ${g.jsName} = new ${ctor}([${a.values.map(litText).join(", ")}]);\n`;
    }
    return `const ${g.jsName} = new ${ctor}(${a.length});\n`;
  }
  return `let ${g.jsName} = ${litText(g.value!)};\n`;
}

function printFunc(f: FuncInst, out: JsPrinter): string {
  out.hidden = new Set();
  const body = out.stmts(f.body, "  ");
  const decls = out.hidden.size > 0 ? `  let ${[...out.hidden].join(", ")};\n` : "";
  const params = f.params.map((p) => out.name(p)).join(", ");
  const head = f.exported ? "export function" : "function";
  return `${head} ${f.jsName}(${params}) {\n${decls}${body}}\n`;
}

export function emitJsChecked(tm: TypedModule): string {
  const printer = new JsPrinter();
  let out = PRELUDE;
  for (const g of tm.globals) out += printGlobal(g);
  for (const f of tm.funcs) out += printFunc(f, printer);
  return out;
}
