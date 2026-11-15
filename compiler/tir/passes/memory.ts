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
// An invariant load (`load.T.inv`, D73) reads a class id: a word an object's construction writes and nothing writes again
// while it lives (SPEC 3.4's "Class ids don't change"). A store at another base, a call, an intrinsic or anything else that
// writes doesn't change it: a store there is to another object, or to this one's other bytes, and whatever a call writes is
// another object's or this one's other bytes, as only a construction writes a class id and it writes a new object's. What
// still changes one is a plain store at the same base over its bytes: a frame slot that a `new` in a loop builds an object in
// again, say, which the passes see as the same base.
import type { Func, Instr, Module } from "../ir.ts";
import { calleeOf, intImm, opParts, PURE_INTRINSICS, valueOps } from "./util.ts";

export interface Addr {
  base: string; // "g:<global>", "a<value>" for a frame slot, "b<value>" for a pointer from a reference, "v<value>"
  off: number | null; // bytes from the base, or null where an index isn't constant
  ident: boolean; // a global or a frame slot: an object of its own
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
export function addrOf(defs: Map<number, Instr>, v: number): Addr {
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

function constInt(defs: Map<number, Instr>, v: number): number | undefined {
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
  return !(a.ident && b.ident);
}

/**
 * What an instruction does to memory, for the passes that move or share loads:
 * - `none`: nothing (pure operations, checks, plain loads, `alloca`, `gen.chk`'s read);
 * - `store`: a plain store, at an address;
 * - `all`: anything that may write anywhere, or orders memory: the passes treat it as writing everything.
 */
export type MemEffect = "none" | "store" | "all";

export function memEffect(ins: Instr, readonly: ReadonlySet<string>): MemEffect {
  const b = opParts(ins.op)[0]!;
  if (b === "store") return isPlainStore(ins) ? "store" : "all";
  if (b === "load") return isPlainLoad(ins) ? "none" : "all";
  if (b === "rmw" || b === "cas" || b === "fence") return "all";
  if (ins.op === "call") {
    const c = calleeOf(ins);
    return c !== undefined && readonly.has(c) ? "none" : "all";
  }
  if (ins.op === "call.indirect") return "all";
  if (ins.op === "intrinsic") {
    const n = ins.ops[0];
    if (n?.t === "name" && (PURE_INTRINSICS.has(n.name) || n.name.startsWith("math.")))
      return "none";
    return "all";
  }
  return "none";
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
  const defs = new Map<number, Instr>();
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
