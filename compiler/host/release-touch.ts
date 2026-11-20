// R33 (SPEC 3.5, D39): whether `@tsl/gc`'s release functions may read or write a module variable, by the whole program's
// call graph, for `releasesTouch(v)` in `@tsl/unsafe`.
//
// Lowering leaves each question as `intrinsic release.touches @v @f1 … @fn`: 1 if any of those functions may read or write
// the global `v`. Only once the module's TIR is built is every call known, so it's answered here, before any pass, at every
// level, and becomes a constant: no TIR any pass or backend sees has the intrinsic.
//
// A function may touch `v` if its own instructions take `v`'s address (`globaladdr @v`, whatever it's used for), if it makes
// an indirect call, if it calls a function that isn't in the module, or if it calls one that may. A recursive cycle is
// settled by taking each function's reach as everything any function it reaches does. Anything else it does can't reach
// `v`: a module variable is never a value in TSL, so its address is only ever `globaladdr`'s, and the answer is 1 for every
// function wherever `v`'s address is used as anything but the address of a plain load or store (stored, passed, returned,
// offset), as memory reached through a pointer might then be `v`. Memory reached through `@tsl/unsafe`'s raw pointers is
// memory a library's SAFETY reasoning says it owns, which is never another module's variables (SPEC Appendix A).
//
// `TMK_R33_OFF=touch` answers 1 everywhere, so `@tsl/gc` writes `stepping` and `spare` around every release call as before
// R33 (the pins tool's off build).
import type { Func, Instr, Module } from "../tir/ir.ts";
import { edgesOf } from "../tir/ir.ts";

const NAME = "release.touches";

function r33Off(): boolean {
  return (process.env.TMK_R33_OFF ?? "").split(",").includes("touch");
}

function isQuestion(ins: Instr): boolean {
  if (ins.op !== "intrinsic") return false;
  const n = ins.ops[0];
  return n?.t === "name" && n.name === NAME;
}

/** The globals whose address is used as anything but a plain load's or store's address operand. */
function escapedGlobals(m: Module): Set<string> {
  const out = new Set<string>();
  for (const f of m.funcs) {
    const addrOf = new Map<number, string>();
    for (const b of f.blocks)
      for (const ins of b.instrs)
        if (ins.op === "globaladdr" && ins.ops[0]?.t === "sym")
          addrOf.set(ins.res[0]!, ins.ops[0].name);
    if (addrOf.size === 0) continue;
    const use = (v: number): void => {
      const g = addrOf.get(v);
      if (g !== undefined) out.add(g);
    };
    for (const b of f.blocks) {
      for (const ins of b.instrs) {
        const plain = /^(load|store)\.[a-z0-9]+\.(na|inv)$/.test(ins.op);
        ins.ops.forEach((o, i) => {
          if (o.t !== "v") return;
          // a plain load's or store's address is its first operand; a store's value is its second
          if (plain && i === 0) return;
          use(o.id);
        });
      }
      for (const e of edgesOf(b.term)) e.args.forEach(use);
      if (b.term.k === "ret") b.term.vals.forEach(use);
      if (b.term.k === "brif") use(b.term.cond);
      if (b.term.k === "switch") use(b.term.val);
    }
  }
  return out;
}

interface Own {
  globals: Set<string>; // globals whose address it takes
  calls: Set<string>; // functions it calls directly
  unknown: boolean; // an indirect call, or a call out of the module
}

function ownOf(f: Func, names: ReadonlySet<string>, fault: string): Own {
  const own: Own = { globals: new Set(), calls: new Set(), unknown: false };
  for (const b of f.blocks) {
    for (const ins of b.instrs) {
      if (ins.op === "globaladdr" && ins.ops[0]?.t === "sym") own.globals.add(ins.ops[0].name);
      else if (ins.op === "call.indirect") {
        // R33's injected `r33-touch-indirect`: an indirect call taken as reaching nothing
        if (fault !== "r33-touch-indirect") own.unknown = true;
      } else if (ins.op === "call") {
        const c = ins.ops[0];
        if (c?.t !== "sym") own.unknown = true;
        else if (!names.has(c.name)) own.unknown = true;
        else own.calls.add(c.name);
      }
    }
  }
  return own;
}

/** Answers every `release.touches` question in the module, in place, with a constant. */
export function resolveReleaseTouches(m: Module): void {
  const questions: Instr[] = [];
  for (const f of m.funcs)
    for (const b of f.blocks) for (const ins of b.instrs) if (isQuestion(ins)) questions.push(ins);
  if (questions.length === 0) return;
  // R33's injected bugs (tools/r33-tests.ts): `r33-touch-own`, each function's own instructions only, not what it calls;
  // `r33-touch-indirect`, an indirect call taken as reaching nothing; `r33-touch-none`, every answer 0. Never set otherwise.
  const fault = process.env.TMK_TEST_TSL ?? "";
  const off = r33Off();
  const names = new Set(m.funcs.map((f) => f.name));
  const own = new Map<string, Own>();
  for (const f of m.funcs) own.set(f.name, ownOf(f, names, fault));
  const escaped = escapedGlobals(m);
  // what each function reaches, worked out once per function asked about: every function its calls lead to, itself too
  const reach = new Map<string, Own>();
  const reachOf = (start: string): Own => {
    const hit = reach.get(start);
    if (hit !== undefined) return hit;
    const out: Own = { globals: new Set(), calls: new Set(), unknown: false };
    const seen = new Set<string>([start]);
    const todo = [start];
    while (todo.length > 0) {
      const n = todo.pop()!;
      const o = own.get(n);
      if (o === undefined) {
        out.unknown = true;
        continue;
      }
      for (const g of o.globals) out.globals.add(g);
      if (o.unknown) out.unknown = true;
      if (fault === "r33-touch-own") continue;
      for (const c of o.calls)
        if (!seen.has(c)) {
          seen.add(c);
          todo.push(c);
        }
    }
    reach.set(start, out);
    return out;
  };
  for (const ins of questions) {
    const g = ins.ops[1];
    let touches = true;
    if (!off && g?.t === "sym" && !escaped.has(g.name)) {
      touches = false;
      for (const o of ins.ops.slice(2)) {
        if (o.t !== "sym") {
          touches = true;
          break;
        }
        const r = reachOf(o.name);
        if (r.unknown || r.globals.has(g.name)) {
          touches = true;
          break;
        }
      }
    }
    if (fault === "r33-touch-none") touches = false;
    ins.op = "iconst.i32";
    ins.ops = [{ t: "i", val: touches ? 1n : 0n }];
  }
}

/**
 * For `TMK_R33_FACTS=1`: each release function's answer for each global asked about, as the questions see them, before
 * they're answered (a diagnostic, printed by lowerToTir's caller; no gate reads it).
 */
export function releaseTouchFacts(m: Module): string[] {
  const out = new Set<string>();
  const names = new Set(m.funcs.map((f) => f.name));
  const own = new Map<string, Own>();
  for (const f of m.funcs) own.set(f.name, ownOf(f, names, ""));
  for (const f of m.funcs)
    for (const b of f.blocks)
      for (const ins of b.instrs) {
        if (!isQuestion(ins)) continue;
        const g = ins.ops[1]?.t === "sym" ? ins.ops[1].name : "?";
        for (const o of ins.ops.slice(2)) {
          if (o.t !== "sym") continue;
          const seen = new Set<string>([o.name]);
          const todo = [o.name];
          let touch = false;
          const why: string[] = [];
          while (todo.length > 0) {
            const n = todo.pop()!;
            const x = own.get(n);
            if (x === undefined) {
              touch = true;
              why.push(`${n}: not in the module`);
              continue;
            }
            if (x.globals.has(g)) {
              touch = true;
              why.push(`${n}: takes ${g}`);
            }
            if (x.unknown) {
              touch = true;
              why.push(`${n}: an indirect call or one out of the module`);
            }
            for (const c of x.calls)
              if (!seen.has(c)) {
                seen.add(c);
                todo.push(c);
              }
          }
          out.add(
            `${o.name} ${g}: ${touch ? "touches" : "never"}${why.length > 0 ? ` (${why.slice(0, 3).join("; ")})` : ""}`,
          );
        }
      }
  return [...out].sort();
}
