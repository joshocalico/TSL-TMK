// Canonical TIR text, its parser, and tirhash (SPEC 4.3).
import { createHash } from "node:crypto";
import {
  isTirType,
  resultTypes,
  type Block,
  type Edge,
  type Func,
  type Global,
  type Instr,
  type Module,
  type Operand,
  type Sig,
  type Term,
  type TirType,
  type TrapSite,
} from "./ir.ts";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function printOperand(o: Operand, op: string): string {
  switch (o.t) {
    case "v":
      return `%${o.id}`;
    case "i":
      return op.startsWith("fconst.") ? `0x${o.val.toString(16)}` : o.val.toString();
    case "ixmax":
      return "ixmax";
    case "trap":
      return `t${o.id}`;
    case "sym":
      return `@${o.name}`;
    case "sig":
      return `sig${o.id}`;
    case "name":
      return o.name;
  }
}

function printEdge(e: Edge): string {
  const args = e.args.length > 0 ? `(${e.args.map((a) => `%${a}`).join(", ")})` : "";
  return `bb${e.block}${args}`;
}

function printTerm(t: Term): string {
  switch (t.k) {
    case "br":
      return `br ${printEdge(t.to)}`;
    case "brif":
      return `brif %${t.cond}, ${printEdge(t.t)}, ${printEdge(t.f)}`;
    case "switch": {
      const cases = t.cases.map((c) => `${c.key}: ${printEdge(c.to)}`).join(", ");
      return `switch %${t.val} [${cases}] default ${printEdge(t.def)}`;
    }
    case "ret":
      return t.vals.length > 0 ? `ret ${t.vals.map((v) => `%${v}`).join(", ")}` : "ret";
    case "trap":
      return `trap t${t.id}`;
    case "unreachable":
      return "unreachable";
  }
}

function printInstr(ins: Instr): string {
  const lhs = ins.res.length > 0 ? `${ins.res.map((r) => `%${r}`).join(", ")} = ` : "";
  const ops = ins.ops.map((o) => printOperand(o, ins.op));
  // `call @f %1, %2` reads better than a comma after the callee.
  const callish = ins.op === "call" || ins.op === "call.indirect" || ins.op === "intrinsic";
  const head = callish && ops.length > 0 ? `${ops[0]!} ` : "";
  const rest = callish ? ops.slice(1) : ops;
  const space = head !== "" || rest.length > 0 ? " " : "";
  return `${lhs}${ins.op}${space}${head}${rest.join(", ")}`.trimEnd();
}

export function printFunc(f: Func): string {
  const params = f.params.map((p) => `%${p}: ${f.types[p]!}`).join(", ");
  const attrs = f.attrs.length > 0 ? ` ${f.attrs.join(" ")}` : "";
  const lines = [`func @${f.name}(${params}) -> (${f.rets.join(", ")})${attrs} {`];
  for (const b of f.blocks) {
    const bp = b.params.map((p) => `%${p}: ${f.types[p]!}`).join(", ");
    lines.push(`bb${b.id}${b.params.length > 0 ? `(${bp})` : ""}:`);
    for (const ins of b.instrs) lines.push(`  ${printInstr(ins)}`);
    lines.push(`  ${printTerm(b.term)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Prints a module, which must already be canonical. */
export function printModule(m: Module): string {
  const lines: string[] = [];
  m.sigs.forEach((s, i) => {
    lines.push(`sig sig${i} (${s.params.join(", ")}) -> (${s.rets.join(", ")})`);
  });
  for (const g of m.globals) {
    const bytes = g.bytes !== undefined ? ` bytes=${hex(g.bytes)}` : "";
    lines.push(`global @${g.name} size=${g.size} align=${g.align} section=${g.section}${bytes}`);
  }
  for (const e of m.externs) {
    lines.push(`extern @${e.name}(${e.params.join(", ")}) -> (${e.rets.join(", ")})`);
  }
  for (const f of m.funcs) lines.push(printFunc(f));
  for (const t of m.traps) {
    const msg = t.msg !== undefined ? ` msg=${t.msg}` : "";
    lines.push(`trap t${t.id} ${t.kind} code=${t.code} ${t.loc}${msg}`);
  }
  return `${lines.join("\n")}\n`;
}

export function tirHash(m: Module): string {
  return createHash("sha256").update(printModule(m)).digest("hex");
}

// --- parser

class ParseError extends Error {}

function fail(line: string, why: string): never {
  throw new ParseError(`TIR parse error: ${why}: ${line}`);
}

function parseTypeList(s: string, line: string): TirType[] {
  const inner = s.trim();
  if (inner === "") return [];
  return inner.split(",").map((t) => {
    const n = t.trim();
    if (!isTirType(n)) fail(line, `bad type ${n}`);
    return n;
  });
}

function parseTyped(s: string, f: Func, line: string): number[] {
  const inner = s.trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => {
    const m = /^%(\d+):\s*(\w+)$/.exec(part.trim());
    if (m === null) fail(line, "bad parameter");
    const id = Number(m[1]);
    if (!isTirType(m[2]!)) fail(line, `bad type ${m[2]!}`);
    f.types[id] = m[2]!;
    return id;
  });
}

function parseVal(tok: string, line: string): number {
  if (!/^%\d+$/.test(tok)) fail(line, `expected a value, got ${tok}`);
  return Number(tok.slice(1));
}

function parseEdge(s: string, line: string): Edge {
  const m = /^bb(\d+)(?:\((.*)\))?$/.exec(s.trim());
  if (m === null) fail(line, `bad edge ${s}`);
  const args = m[2] === undefined || m[2].trim() === "" ? [] : m[2].split(",");
  return { block: Number(m[1]), args: args.map((a) => parseVal(a.trim(), line)) };
}

/** Splits on commas outside parentheses and brackets. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function parseTerm(s: string, line: string): Term | null {
  if (s === "unreachable") return { k: "unreachable" };
  if (s === "ret") return { k: "ret", vals: [] };
  if (s.startsWith("ret ")) {
    return {
      k: "ret",
      vals: s
        .slice(4)
        .split(",")
        .map((v) => parseVal(v.trim(), line)),
    };
  }
  if (s.startsWith("trap ")) return { k: "trap", id: Number(s.slice(6)) };
  if (s.startsWith("br ")) return { k: "br", to: parseEdge(s.slice(3), line) };
  if (s.startsWith("brif ")) {
    const parts = splitTop(s.slice(5));
    if (parts.length !== 3) fail(line, "brif needs three parts");
    return {
      k: "brif",
      cond: parseVal(parts[0]!.trim(), line),
      t: parseEdge(parts[1]!, line),
      f: parseEdge(parts[2]!, line),
    };
  }
  const sw = /^switch (%\d+) \[(.*)\] default (.*)$/.exec(s);
  if (sw !== null) {
    const cases = splitTop(sw[2]!).map((c) => {
      const m = /^\s*(-?\d+):\s*(.*)$/.exec(c);
      if (m === null) fail(line, "bad switch case");
      return { key: BigInt(m[1]!), to: parseEdge(m[2]!, line) };
    });
    return { k: "switch", val: parseVal(sw[1]!, line), cases, def: parseEdge(sw[3]!, line) };
  }
  return null;
}

function parseOperand(tok: string, line: string): Operand {
  if (tok.startsWith("%")) return { t: "v", id: parseVal(tok, line) };
  if (tok.startsWith("@")) return { t: "sym", name: tok.slice(1) };
  if (tok === "ixmax") return { t: "ixmax" };
  if (/^t\d+$/.test(tok)) return { t: "trap", id: Number(tok.slice(1)) };
  if (/^sig\d+$/.test(tok)) return { t: "sig", id: Number(tok.slice(3)) };
  if (/^-?\d+$/.test(tok) || /^0x[0-9a-f]+$/.test(tok)) return { t: "i", val: BigInt(tok) };
  if (/^[\w.]+$/.test(tok)) return { t: "name", name: tok };
  fail(line, `bad operand ${tok}`);
}

/** Parses canonical text. print(parse(print(x))) = print(x), checked in tir.test.ts. */
export function parseModule(text: string): Module {
  const m: Module = { sigs: [], globals: [], funcs: [], traps: [], externs: [] };
  const lines = text.split("\n");
  const sigOf = new Map<string, TirType[]>();
  // Headers first, so a call can see a function defined later in the file.
  for (const line of lines) {
    const h = /^func @(\S+?)\((.*?)\) -> \((.*?)\)/.exec(line);
    if (h !== null) sigOf.set(h[1]!, parseTypeList(h[3]!, line));
  }
  let f: Func | null = null;
  let b: Block | null = null;
  for (const line of lines) {
    if (line === "") continue;
    if (f === null) {
      const sig = /^sig sig(\d+) \((.*?)\) -> \((.*?)\)$/.exec(line);
      if (sig !== null) {
        const s: Sig = { params: parseTypeList(sig[2]!, line), rets: parseTypeList(sig[3]!, line) };
        m.sigs[Number(sig[1])] = s;
        continue;
      }
      const g = /^global @(\S+) size=(\d+) align=(\d+) section=(\S+)(?: bytes=([0-9a-f]*))?$/.exec(
        line,
      );
      if (g !== null) {
        const global: Global = {
          name: g[1]!,
          size: Number(g[2]),
          align: Number(g[3]),
          section: g[4]!,
        };
        if (g[5] !== undefined) {
          const raw = g[5];
          const bytes = new Uint8Array(raw.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
          }
          global.bytes = bytes;
        }
        m.globals.push(global);
        continue;
      }
      const ext = /^extern @(\S+?)\((.*?)\) -> \((.*?)\)$/.exec(line);
      if (ext !== null) {
        m.externs.push({
          name: ext[1]!,
          params: parseTypeList(ext[2]!, line),
          rets: parseTypeList(ext[3]!, line),
        });
        continue;
      }
      const t = /^trap t(\d+) (\S+) code=(\d+) (\S+?)(?: msg=(.*))?$/.exec(line);
      if (t !== null) {
        const site: TrapSite = {
          id: Number(t[1]),
          kind: t[2]!,
          code: Number(t[3]),
          loc: t[4]!,
        };
        if (t[5] !== undefined) site.msg = t[5];
        m.traps.push(site);
        continue;
      }
      const h = /^func @(\S+?)\((.*?)\) -> \((.*?)\)(.*) \{$/.exec(line);
      if (h === null) fail(line, "expected a declaration");
      f = {
        name: h[1]!,
        params: [],
        rets: parseTypeList(h[3]!, line),
        attrs: h[4]!.trim() === "" ? [] : h[4]!.trim().split(" "),
        blocks: [],
        types: [],
      };
      f.params = parseTyped(h[2]!, f, line);
      continue;
    }
    if (line === "}") {
      m.funcs.push(f);
      f = null;
      b = null;
      continue;
    }
    const head = /^bb(\d+)(?:\((.*)\))?:$/.exec(line);
    if (head !== null) {
      b = {
        id: Number(head[1]),
        params: parseTyped(head[2] ?? "", f, line),
        instrs: [],
        term: { k: "unreachable" },
      };
      f.blocks.push(b);
      continue;
    }
    if (b === null) fail(line, "instruction outside a block");
    const body = line.trim();
    const term = parseTerm(body, line);
    if (term !== null) {
      b.term = term;
      continue;
    }
    const eq = /^((?:%\d+(?:, )?)+) = (.*)$/.exec(body);
    const res = eq !== null ? eq[1]!.split(", ").map((r) => parseVal(r.trim(), line)) : [];
    // A separator is a comma and a space. A generic's name, `@f<u8,f64>`, has commas of its own.
    const rest = (eq !== null ? eq[2]! : body)
      .trim()
      .split(/\s+/)
      .map((tok) => tok.replace(/,$/, ""));
    const ins: Instr = {
      op: rest[0]!,
      ops: rest.slice(1).map((tok) => parseOperand(tok, line)),
      res,
    };
    const tys = resultTypes(m, sigOf, ins);
    if (tys.length !== res.length) fail(line, "wrong number of results");
    for (let i = 0; i < res.length; i++) f.types[res[i]!] = tys[i]!;
    b.instrs.push(ins);
  }
  return m;
}
