// What memory an instruction may read or write, for value numbering and loop-invariant code motion (SPEC 4.3, D73).
//
// A plain load (`load.T.na`) reads `size` bytes at an address. Each address is taken apart into a base and a constant offset
// where it can be: a `gep` at a constant index adds to the offset, and the base is a global, a frame slot, or any other value.
// Two accesses at one base and constant offsets alias only where their bytes overlap. A global and a frame slot, or two of
// either, are different objects, and never alias. Anything else may alias anything.
//
// What writes: a plain store writes its bytes. Everything else that touches memory is a clobber of all of it, as far as the
// passes are concerned: atomic loads and stores, read-modify-writes, fences, device loads and stores, calls that may write,
// indirect calls, and the intrinsics with effects (`mem.fill`, `mem.copy`, `mem.ensure`, the bare-metal runtime's). `rc`'s
// count operations are calls or plain loads and stores of the count word, so they fall under the same rules. A call writes
// nothing only where the callee, and everything it calls, provably writes nothing outside its own frame.
//
// R27, fresh-allocation separation (D77): lowering notes a load of a separated field (`Instr.sep`, compiler/host/separate.ts)
// and every load and store of an object's field (`Instr.obj`). A value from a separated field's load, and what's worked out
// from it (an offset, a widening, a block parameter every edge gives one, an add of one and something that isn't one), is the
// address of a block no object is in, which only its class's code reaches (`sepValues`). An access at such an address and an
// object's field's access, or a global's or a frame slot's, never alias: tslc's rule proves the block holds no object, and
// the allocators that no global, frame or object shares it. A call writes only such blocks where the callee, and all it
// calls, store nowhere else but their own frame slots (`writeSummaries`); such a call, or a fill or copy into a block, is a
// write of "separated memory", which changes no object's field.
//
// An invariant load (`load.T.inv`, D73) reads a class id: a word an object's construction writes and nothing writes again
// while it lives (SPEC 3.4's "Class ids don't change"). A store at another base, a call, an intrinsic or anything else that
// writes doesn't change it: a store there is to another object, or to this one's other bytes, and whatever a call writes is
// another object's or this one's other bytes, as only a construction writes a class id and it writes a new object's. What
// still changes one is a plain store at the same base over its bytes: a frame slot that a `new` in a loop builds an object in
// again, say, which the passes see as the same base.
import { edgesOf, ValMap, type Func, type Instr, type Module, type ValLookup } from "../ir.ts";
import { calleeOf, intImm, opParts, PURE_INTRINSICS, valueOps } from "./util.ts";

export interface Addr {
  base: string; // "g:<global>", "a<value>" for a frame slot, "b<value>" for a pointer from a reference, "v<value>"
  off: number | null; // bytes from the base, or null where an index isn't constant
  ident: boolean; // a global or a frame slot: an object of its own
  sep?: boolean; // R27: in a separated field's block (sepValues), so no object's, global's or frame slot's
  obj?: boolean; // R27: an access of an object's field (`Instr.obj`), so never in a separated field's block
}

/** R27: any write of separated memory, as a call that writes only separated fields' blocks, or a fill into one, is. */
export const SEP_ANY: Addr = { base: "s*", off: null, ident: false, sep: true };
/** The bytes such a write may touch: any. */
export const SEP_SIZE = 2 ** 40;

/** R27's injected bugs (D77, tools/r27-tests.ts): read by the passes from what the manager sets. */
export interface SepFaults {
  /** A summary missing a write: a store at any address but a frame slot's is taken as one into separated memory. */
  summaryMiss?: boolean;
  /** An alias the separation misses: every value loaded as a 64-bit word is taken as a separated field's block. */
  aliasAny?: boolean;
}
let sepFaults: SepFaults = {};
export function setSepFaults(f: SepFaults): void {
  sepFaults = f;
}

/** Whether R27's separation is off (`TMK_R27_OFF=sep`, the pins tool): no value is a block's, no call writes only blocks. */
function sepOff(): boolean {
  return (process.env.TMK_R27_OFF ?? "").split(",").includes("sep");
}

/**
 * R27: the values of a function that are addresses in a separated field's block: a separated field's load (`Instr.sep`), and
 * what's worked out from one: a `gep` from it, a cast either way, an add or subtract of one and a value that isn't one, and a
 * block parameter every edge gives one (settled from all of them taken as one, and taken back until nothing changes).
 */
export function sepValues(f: Func): Set<number> {
  const out = new Set<number>();
  if (sepOff()) return out;
  // R36: each instruction's rule read once, before going round, not again in every round (it was a tenth of -O1's value
  // numbering and LICM); the rounds and what they decide are as before. The rule, by kind: 1 a separated field's load
  // (always one); 2 a `gep` or a cast of its first operand (one if that is); 3 an add (one if exactly one operand is); 4 a
  // subtract (one if its first is and its second isn't); 0 anything else (never one). An operand that isn't there is -1.
  const res: number[] = [];
  const kind: number[] = [];
  const a0: number[] = [];
  const a1: number[] = [];
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.res.length !== 1) continue;
      // (R36: by the first letter, the operations of no kind but 0 go before their name is split)
      const c0 = ins.op.charCodeAt(0);
      if (c0 !== 108 && c0 !== 103 && c0 !== 98 && c0 !== 97 && c0 !== 115) continue; // l g b a s
      const p = opParts(ins.op);
      let k = 0;
      let x = -1;
      let y = -1;
      if (p[0] === "load") {
        if (ins.sep === true || (sepFaults.aliasAny === true && p[1] === "i64" && isPlainLoad(ins)))
          k = 1;
      } else if (ins.op === "gep" || ins.op === "bitcast.ptr" || ins.op === "bitcast.i64") {
        k = 2;
        for (const o of ins.ops)
          if (o.t === "v") {
            x = o.id;
            break;
          }
      } else if (
        (p[0] === "add" || p[0] === "sub") &&
        (p[1] === "i64" || p[1] === "ix" || (p[1] === "chk" && (p[3] === "i64" || p[3] === "ix")))
      ) {
        k = p[0] === "add" ? 3 : 4;
        let n = 0;
        for (const o of ins.ops)
          if (o.t === "v") {
            if (n === 0) x = o.id;
            else if (n === 1) y = o.id;
            n++;
          }
      }
      // an instruction of kind 0 is never one, and was never put in, so going round never changes it: left out
      if (k === 0) continue;
      res.push(ins.res[0]!);
      kind.push(k);
      a0.push(x);
      a1.push(y);
    }
  }
  // membership while going round in bytes by value number; the Set given back holds the same values
  const inn = new Uint8Array(f.types.length);
  const has = (v: number): boolean => v >= 0 && inn[v] === 1;
  // Block parameters: every incoming value.
  const byId = new Map<number, Func["blocks"][number]>();
  for (const b of f.blocks) byId.set(b.id, b);
  const incoming = new Map<number, number[]>();
  for (const b of f.blocks)
    for (const e of edgesOf(b.term))
      byId.get(e.block)?.params.forEach((p, i) => {
        let l = incoming.get(p);
        if (l === undefined) incoming.set(p, (l = []));
        l.push(e.args[i]!);
      });
  const params = [...incoming.keys()];
  // Optimistic: every parameter in, the rest by its definition, then out what isn't, until nothing changes.
  for (const p of params) inn[p] = 1;
  for (let round = 0; round < 64; round++) {
    let changed = false;
    for (let i = 0; i < res.length; i++) {
      const r = res[i]!;
      const k = kind[i]!;
      const now =
        k === 1
          ? true
          : k === 2
            ? has(a0[i]!)
            : k === 3
              ? has(a0[i]!) !== has(a1[i]!)
              : k === 4
                ? has(a0[i]!) && !has(a1[i]!)
                : false;
      if (now !== (inn[r] === 1)) {
        inn[r] = now ? 1 : 0;
        changed = true;
      }
    }
    for (const p of params) {
      const now = incoming.get(p)!.every((v) => inn[v] === 1);
      if (now !== (inn[p] === 1)) {
        inn[p] = now ? 1 : 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (let v = 0; v < inn.length; v++) if (inn[v] === 1) out.add(v);
  return out;
}

/** The address an access (a plain load or store) uses, with R27's notes: in a block, or an object's field. */
export function accessAddr(defs: ValLookup<Instr>, ins: Instr, sep: ReadonlySet<number>): Addr {
  const at = valueOps(ins)[0]!;
  const a = addrOf(defs, at);
  // (R36: made field by field, in the same order, not by spreading)
  const out: Addr = { base: a.base, off: a.off, ident: a.ident };
  if (a.sep !== undefined) out.sep = a.sep;
  if (a.obj !== undefined) out.obj = a.obj;
  if (sep.has(at)) out.sep = true;
  if (ins.obj === true) out.obj = true;
  return out;
}

const BYTES: Record<string, number> = {
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  ix: 8,
  ptr: 8,
  f32: 4,
  f64: 8,
};

/** The bytes a plain load or store of an operation touches: its type's size, with `ix` and `ptr` taken as 8. */
export function accessBytes(op: string): number {
  return BYTES[opParts(op)[1]!] ?? 8;
}

/** A plain, non-atomic load: `load.T.na`, or an invariant one, `load.T.inv`, which is a plain load the passes may share more. */
export function isPlainLoad(ins: Instr): boolean {
  const p = opParts(ins.op);
  return p[0] === "load" && p.length === 3 && (p[2] === "na" || p[2] === "inv");
}

/** A load of a class id (D73): `load.T.inv`. */
export function isInvariantLoad(ins: Instr): boolean {
  const p = opParts(ins.op);
  return p[0] === "load" && p.length === 3 && p[2] === "inv";
}

/**
 * Whether a write may change what a load of `size` bytes at `a` reads: `w` is a plain store's address and size, or "all",
 * anything else that writes. An invariant load is changed only by a plain store at its own base over its bytes.
 */
export function writeChanges(
  a: Addr,
  size: number,
  inv: boolean,
  w: { addr: Addr; size: number } | "all",
): boolean {
  if (w === "all") return !inv;
  if (inv) return w.addr.base === a.base && mayAlias(a, size, w.addr, w.size);
  return mayAlias(a, size, w.addr, w.size);
}

/** A plain, non-atomic store: `store.T.na`. */
export function isPlainStore(ins: Instr): boolean {
  const p = opParts(ins.op);
  return p[0] === "store" && p.length === 3 && p[2] === "na";
}

/** Takes an address apart into a base and an offset. `defs` maps a value to the instruction defining it. */
export function addrOf(defs: ValLookup<Instr>, v: number): Addr {
  let off = 0;
  let cur = v;
  for (let guard = 0; guard < 16; guard++) {
    const d = defs.get(cur);
    if (d === undefined) return { base: `v${cur}`, off, ident: false };
    if (d.op === "gep") {
      const [b, idx] = valueOps(d) as [number, number];
      const scale = Number(intImm(d, 0));
      const k = Number(intImm(d, 1));
      const c = constInt(defs, idx);
      if (c === undefined) return { base: `v${b}`, off: null, ident: false };
      off += c * scale + k;
      cur = b;
      continue;
    }
    if (d.op === "globaladdr") {
      const s = d.ops[0];
      return { base: `g:${s?.t === "sym" ? s.name : "?"}`, off, ident: true };
    }
    if (d.op === "alloca") return { base: `a${cur}`, off, ident: true };
    if (d.op === "bitcast.ptr") return { base: `b${valueOps(d)[0]!}`, off, ident: false };
    return { base: `v${cur}`, off, ident: false };
  }
  return { base: `v${cur}`, off: null, ident: false };
}

function constInt(defs: ValLookup<Instr>, v: number): number | undefined {
  const d = defs.get(v);
  if (d === undefined || !d.op.startsWith("iconst.")) return undefined;
  const x = intImm(d, 0);
  return x >= -(1n << 40n) && x <= 1n << 40n ? Number(x) : undefined;
}

/** Whether two accesses of these sizes may touch the same byte. */
export function mayAlias(a: Addr, sa: number, b: Addr, sb: number): boolean {
  if (a.base === b.base) {
    if (a.off === null || b.off === null) return true;
    return a.off < b.off + sb && b.off < a.off + sa;
  }
  // R27 (D77): a separated field's block holds no object, and is no global's or frame slot's
  if (apart(a, b) || apart(b, a)) return false;
  return !(a.ident && b.ident);
}

/** R27: `x` is in a separated field's block, and `y` an object's field, a global or a frame slot. */
function apart(x: Addr, y: Addr): boolean {
  return x.sep === true && x.obj !== true && y.sep !== true && (y.obj === true || y.ident);
}

/**
 * What an instruction does to memory, for the passes that move or share loads:
 * - `none`: nothing (pure operations, checks, plain loads, `alloca`, `gen.chk`'s read);
 * - `store`: a plain store, at an address;
 * - `all`: anything that may write anywhere, or orders memory: the passes treat it as writing everything.
 */
export type MemEffect = "none" | "store" | "sep" | "all";

/**
 * - `sep` (R27): a write somewhere in separated fields' blocks only: a call whose callee writes nothing else (`sepOnly`), or a
 *   fill or copy into a block (its address in `sep`, the function's sepValues).
 */
export function memEffect(
  ins: Instr,
  readonly: ReadonlySet<string>,
  sepOnly?: ReadonlySet<string>,
  sep?: ReadonlySet<number>,
): MemEffect {
  const b = opParts(ins.op)[0]!;
  if (b === "store") return isPlainStore(ins) ? "store" : "all";
  if (b === "load") return isPlainLoad(ins) ? "none" : "all";
  if (b === "rmw" || b === "cas" || b === "fence") return "all";
  if (ins.op === "call") {
    const c = calleeOf(ins);
    if (c !== undefined && readonly.has(c)) return "none";
    return c !== undefined && sepOnly?.has(c) === true ? "sep" : "all";
  }
  if (ins.op === "call.indirect") return "all";
  if (ins.op === "intrinsic") {
    const n = ins.ops[0];
    if (n?.t === "name" && (PURE_INTRINSICS.has(n.name) || n.name.startsWith("math.")))
      return "none";
    if (n?.t === "name" && (n.name === "mem.fill" || n.name === "mem.copy") && sep !== undefined) {
      const dst = valueOps(ins)[0];
      if (dst !== undefined && sep.has(dst)) return "sep";
    }
    return "all";
  }
  return "none";
}

/** What a write is, for the passes: a plain store's access, any write of separated memory, or anything. */
export function writeOf(
  ins: Instr,
  defs: ValLookup<Instr>,
  readonly: ReadonlySet<string>,
  sepOnly: ReadonlySet<string> | undefined,
  sep: ReadonlySet<number>,
): { addr: Addr; size: number } | "all" | null {
  const e = memEffect(ins, readonly, sepOnly, sep);
  if (e === "all") return "all";
  if (e === "sep") return { addr: SEP_ANY, size: SEP_SIZE };
  if (e === "store") return { addr: accessAddr(defs, ins, sep), size: accessBytes(ins.op) };
  return null;
}

/**
 * The functions of a module that write nothing outside their own frame, whatever they're called with: no store but to a
 * frame slot of their own, no atomic, device access, fence or intrinsic with effects, no indirect call, and calls only to
 * functions like them. Recursion is settled by starting from "writes nothing" and taking it back until nothing changes.
 * Calls to functions outside the module write, as far as anyone here knows.
 */
export function readonlyFunctions(m: Module): Set<string> {
  const byName = new Map<string, Func>();
  for (const f of m.funcs) byName.set(f.name, f);
  const ro = new Set<string>();
  const calls = new Map<string, string[]>();
  for (const f of m.funcs) {
    const own = ownWrites(f);
    if (own === null) continue;
    ro.add(f.name);
    calls.set(f.name, own);
  }
  for (let changed = true, round = 0; changed && round < m.funcs.length + 2; round++) {
    changed = false;
    for (const [name, cs] of calls) {
      if (!ro.has(name)) continue;
      if (cs.some((c) => !ro.has(c) || !byName.has(c))) {
        ro.delete(name);
        changed = true;
      }
    }
  }
  return ro;
}

/** The functions f calls, if f's own instructions write nothing outside its frame; null if they do. */
function ownWrites(f: Func): string[] | null {
  const defs = new ValMap<Instr>(f.types.length);
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) defs.set(r, ins);
  const called: string[] = [];
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op === "call") {
        const c = calleeOf(ins);
        if (c === undefined) return null;
        called.push(c);
        continue;
      }
      if (isPlainStore(ins)) {
        // A store to its own frame slot isn't seen once it returns.
        if (addrOf(defs, valueOps(ins)[0]!).base.startsWith("a")) continue;
        return null;
      }
      if (memEffect(ins, EMPTY) === "all") return null;
    }
  }
  return called;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * R27 (D77): what each function of a module may write, for calls: `readonly`, nothing outside its own frame (as
 * readonlyFunctions); `sepOnly`, nothing but its own frame slots and separated fields' blocks (stores at, and fills and
 * copies into, addresses from a separated field's load), and calls only to functions like that. Settled from each function's
 * own writes, taken up through what it calls until nothing changes; a call outside the module writes anything.
 */
export function writeSummaries(m: Module): {
  readonly: Set<string>;
  sepOnly: Set<string>;
} {
  const readonly = readonlyFunctions(m);
  const sepOnly = new Set<string>();
  if (sepOff()) return { readonly, sepOnly };
  const byName = new Set(m.funcs.map((f) => f.name));
  const calls = new Map<string, string[]>();
  for (const f of m.funcs) {
    if (readonly.has(f.name)) continue;
    const own = ownSepWrites(f);
    if (own === null) continue;
    sepOnly.add(f.name);
    calls.set(f.name, own);
  }
  for (let changed = true, round = 0; changed && round < m.funcs.length + 2; round++) {
    changed = false;
    for (const [name, cs] of calls) {
      if (!sepOnly.has(name)) continue;
      if (cs.some((c) => !byName.has(c) || (!readonly.has(c) && !sepOnly.has(c)))) {
        sepOnly.delete(name);
        changed = true;
      }
    }
  }
  return { readonly, sepOnly };
}

/** The functions f calls, if f's own instructions write nothing but its frame and separated fields' blocks; null if not. */
function ownSepWrites(f: Func): string[] | null {
  const defs = new ValMap<Instr>(f.types.length);
  for (const b of f.blocks) for (const ins of b.instrs) for (const r of ins.res) defs.set(r, ins);
  const sep = sepValues(f);
  const called: string[] = [];
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op === "call") {
        const c = calleeOf(ins);
        if (c === undefined) return null;
        called.push(c);
        continue;
      }
      if (isPlainStore(ins)) {
        const a = accessAddr(defs, ins, sep);
        if (a.base.startsWith("a")) continue;
        // the injected `r27-summary-miss`: a store anywhere is taken as one into a block
        if ((a.sep === true && a.obj !== true) || sepFaults.summaryMiss === true) continue;
        return null;
      }
      const e = memEffect(ins, EMPTY, EMPTY, sep);
      if (e === "sep") continue;
      if (e === "all") return null;
    }
  }
  return called;
}
