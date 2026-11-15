// The whole native path: TIR in, an arm64 Image out, with no other tool in the way (SPEC 4.4, 5.10).
// Same module and options give the same bytes: functions and globals are in canonical order, and
// nothing reads a clock, a path, or a hash order.
import { FREM_HELPER } from "../tir/helpers.ts";
import { canonicalize, type Func, type Global, type Module, type TrapSite } from "../tir/ir.ts";
import { printModule } from "../tir/text.ts";
import { verifyModule } from "../tir/verify.ts";
import { backendFaults, Code, emitFunction, type EmitContext, mathSymbol } from "./emit.ts";
import * as E from "./encode.ts";
import { libmFuncs } from "./libm.ts";
import { BULK_GUARD_BYTES, type BulkFault, rtModule } from "./rt-tir.ts";
import { emitRoutines, emitStart, IMAGE_TAIL_BYTES } from "./runtime.ts";

export interface ImageInput {
  module: Module; // the program, canonical or not
  driverFuncs: Func[]; // must define __tmk_main and __rt_trap_message
  driverGlobals: Global[];
  driverTraps?: TrapSite[];
  extraSigs?: Module["sigs"];
  ramBytes: number;
  stackBytes?: number; // a test's smaller stack, against the same guard
  bulkBytes?: number; // the RAM channel for bulk output (SPEC 8.2): none means everything goes to the PL011
  bulkFault?: BulkFault; // that channel going wrong, for the test that the harness notices
  /**
   * The level for the backend's own code shape (D75): what made the program's TIR (`Module.opt`) unless given. At -O0 the
   * backend is exactly what it was before B3, byte for byte; at -O1 and -O2 the program's functions get global accesses
   * through PC-relative offsets, compares fused into branches through block parameters, rematerialisation instead of spills,
   * and loop layout. The runtime and the driver are the same at every level.
   */
  level?: 0 | 1 | 2;
}

export interface ImageOutput {
  bytes: Uint8Array;
  codeBytes: number; // instructions and their constant pools
  dataBytes: number; // initialised data in the file
  bssBytes: number;
  ranges: { name: string; from: number; to: number }[]; // byte ranges of instructions in the image
  symbols: Map<string, number>; // name to byte offset
  readonly tirText: string; // worked out when asked for: it's the size of the program, for each image
  stats: { functions: number; spilledSlots: number };
  bulk?: { ramBytes: number; offset: number; bytes: number }; // where a harness finds the channel, as an offset into RAM
}

export function reachable(all: Map<string, Func>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    const f = all.get(name);
    if (f === undefined) throw new Error(`native: no function @${name}`);
    seen.add(name);
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "call" || ins.op === "funcaddr") {
          const s = ins.ops[0];
          if (s?.t === "sym") stack.push(s.name);
        } else if (ins.op.startsWith("frem.")) {
          stack.push("__frem.f64");
        } else if (ins.op === "intrinsic") {
          const n = ins.ops[0];
          if (n?.t === "name" && n.name.startsWith("math.")) stack.push(mathSymbol(n.name));
        }
      }
    }
  }
  return seen;
}

export const ROOTS = ["__rt_main", "__rt_exception", "__rt_trap", "__tmk_main"];

export function usedGlobals(funcs: Func[]): Set<string> {
  const used = new Set<string>();
  for (const f of funcs) {
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        if (ins.op === "globaladdr" && ins.ops[0]?.t === "sym") used.add(ins.ops[0].name);
      }
    }
  }
  return used;
}

/** Static objects' addresses and prefixes go in before anything runs (SPEC 3.5). */
export function withStatics(inp: ImageInput): Func[] {
  if (!inp.module.funcs.some((f) => f.name === "__statics")) return inp.driverFuncs;
  return inp.driverFuncs.map((f) => {
    if (f.name !== "__tmk_main") return f;
    const [first, ...rest] = f.blocks;
    const call = { op: "call", ops: [{ t: "sym" as const, name: "__statics" }], res: [] };
    return { ...f, blocks: [{ ...first!, instrs: [call, ...first!.instrs] }, ...rest] };
  });
}

export function buildImage(inp: ImageInput): ImageOutput {
  if (inp.module.externs.length > 0) {
    throw new Error(
      `native: a build with no fallback can't have externs: ${inp.module.externs.map((e) => e.name).join(", ")}`,
    );
  }
  const bulkBytes = inp.bulkBytes ?? 0;
  const rt = rtModule(bulkBytes, inp.bulkFault);
  const helpers = [FREM_HELPER(), ...libmFuncs().funcs];
  const merged: Module = {
    sigs: [...inp.module.sigs, ...(inp.extraSigs ?? [])],
    globals: [...inp.module.globals, ...rt.globals, ...inp.driverGlobals, ...libmFuncs().globals],
    funcs: [...inp.module.funcs, ...rt.funcs, ...helpers, ...withStatics(inp)],
    traps: [...inp.module.traps, ...rt.traps, ...(inp.driverTraps ?? [])],
    externs: [],
  };
  const byName = new Map<string, Func>();
  for (const f of merged.funcs) {
    if (byName.has(f.name)) throw new Error(`native: two functions named @${f.name}`);
    byName.set(f.name, f);
  }
  const keep = reachable(byName, ROOTS);
  const kept = merged.funcs.filter((f) => keep.has(f.name));
  const globalsUsed = usedGlobals(kept);
  for (const g of ["__mem_base", "__mem_limit", "__exc_stack", "__rt_jmp", "__rt_try_active"]) {
    globalsUsed.add(g);
  }
  // Traps stay as they are: canonicalize renumbers only those a kept function names.
  const m = canonicalize({
    ...merged,
    funcs: kept,
    globals: merged.globals.filter((g) => globalsUsed.has(g.name)),
  });
  const errors = verifyModule(m);
  if (errors.length > 0) throw new Error(`native: TIR verifier:\n${errors.join("\n")}`);

  const code = new Code();
  const header = emitStart(code, inp.ramBytes, inp.stackBytes, bulkBytes);
  emitRoutines(code);
  const trapCode = new Map<number, number>();
  for (const t of m.traps) trapCode.set(t.id, t.code);
  const level = inp.level ?? inp.module.opt ?? 0;
  const programFuncs = new Set(inp.module.funcs.map((f) => f.name));
  const ctx: EmitContext = {
    code,
    m,
    trapCode,
    funcs: byName,
    stats: { spilledValues: 0, frames: 0 },
    shape: (f) => (level > 0 && programFuncs.has(f.name) ? backendFaults() : null),
    nullPcs: [],
  };
  for (const f of m.funcs) emitFunction(f, ctx);
  const codeBytes = code.here * 4;
  // R7: the loads standing for an explicit null check (shape.ts's implicitNullChecks), a count then for each its address
  // less the table's and the address it faults at through null (its offset), for __rt_exception's __rt_null_listed. The
  // bytes are filled in once the table has its address.
  const nullPcs = ctx.nullPcs!;
  const nullAt = m.globals.findIndex((g) => g.name === "__rt_null_pcs");
  let nullTable: Global | undefined;
  if (nullAt >= 0 && nullPcs.length > 0) {
    // A new global, not the runtime module's, which another image may share.
    const size = 8 * (2 * nullPcs.length + 1);
    nullTable = { ...m.globals[nullAt]!, size, bytes: new Uint8Array(size) };
    new DataView(nullTable.bytes!.buffer).setBigUint64(0, BigInt(nullPcs.length), true);
    m.globals[nullAt] = nullTable;
  }

  // Data: initialised globals in the file, then bss, then the tables the start code builds.
  const initialised: Global[] = [];
  const zero: Global[] = [];
  for (const g of m.globals) (g.bytes?.some((b) => b !== 0) === true ? initialised : zero).push(g);
  const symbols = new Map<string, number>();
  let at = Math.ceil(codeBytes / 4096) * 4096;
  const dataStart = at;
  for (const g of initialised) {
    at = Math.ceil(at / g.align) * g.align;
    symbols.set(`g:${g.name}`, at);
    at += g.size;
  }
  const fileEnd = at;
  at = Math.ceil(at / 16) * 16;
  symbols.set("g:__bss_start", at);
  for (const g of zero) {
    at = Math.ceil(at / Math.max(g.align, 1)) * Math.max(g.align, 1);
    symbols.set(`g:${g.name}`, at);
    at += g.size;
  }
  at = Math.ceil(at / 16) * 16;
  symbols.set("g:__bss_end", at);
  at = Math.ceil(at / 4096) * 4096;
  symbols.set("g:__tables", at);
  at += IMAGE_TAIL_BYTES;
  symbols.set("g:__image_end", at);
  const imageSize = at;
  for (const [name, word] of code.symbols) symbols.set(name, word * 4);
  if (nullTable !== undefined) {
    const base = symbols.get("g:__rt_null_pcs")!;
    const view = new DataView(nullTable.bytes!.buffer);
    nullPcs.forEach((x, i) => {
      view.setBigInt64(8 * (2 * i + 1), BigInt(x.pc * 4 - base), true);
      view.setBigInt64(8 * (2 * i + 2), BigInt(x.off), true);
    });
  }

  // Link.
  const w = code.words;
  for (const fx of code.fixups) {
    const target = symbols.get(fx.sym);
    if (target === undefined) throw new Error(`native: undefined symbol ${fx.sym}`);
    const pc = fx.at * 4;
    switch (fx.kind) {
      case "b26":
        w[fx.at] = E.b(target - pc);
        break;
      case "bl26":
        w[fx.at] = E.bl(target - pc);
        break;
      case "adrp": {
        const pages = Math.floor((target + (fx.addend ?? 0)) / 4096) - Math.floor(pc / 4096);
        w[fx.at] = E.adrp(w[fx.at]! & 31, pages);
        break;
      }
      case "add12": {
        const rd = w[fx.at]! & 31;
        const rn = (w[fx.at]! >>> 5) & 31;
        w[fx.at] = E.arithImm("add", true, rd, rn, target & 4095);
        break;
      }
      case "ldr12x":
        throw new Error("unused fixup");
      case "lo12": {
        // A load or store's unsigned offset, scaled by its size: the emitter only uses it where the target is aligned to that.
        const t = target + (fx.addend ?? 0);
        const word = w[fx.at]!;
        const size = 1 << (word >>> 30);
        const vector = ((word >>> 26) & 1) === 1;
        const scale = vector && (word >>> 23) & 1 ? 16 : size;
        if ((t & 4095) % scale !== 0)
          throw new Error(`native: ${fx.sym} + ${fx.addend ?? 0} isn't aligned for its access`);
        w[fx.at] = ((word & ~(0xfff << 10)) | (((t & 4095) / scale) << 10)) >>> 0;
        break;
      }
    }
  }
  w[header.imageSizeAt] = imageSize >>> 0;

  const bytes = new Uint8Array(fileEnd);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < w.length; i++) view.setUint32(i * 4, w[i]!, true);
  for (const g of initialised) bytes.set(g.bytes!, symbols.get(`g:${g.name}`)!);
  return {
    bytes,
    codeBytes,
    dataBytes: fileEnd - dataStart,
    bssBytes: symbols.get("g:__bss_end")! - symbols.get("g:__bss_start")!,
    ranges: code.ranges.map((r) => ({ name: r.name, from: r.from * 4, to: r.to * 4 })),
    symbols,
    get tirText(): string {
      return printModule(m);
    },
    stats: { functions: m.funcs.length, spilledSlots: ctx.stats.spilledValues },
    ...(bulkBytes > 0
      ? {
          bulk: {
            ramBytes: inp.ramBytes,
            offset: inp.ramBytes + BULK_GUARD_BYTES,
            bytes: bulkBytes,
          },
        }
      : {}),
  };
}
