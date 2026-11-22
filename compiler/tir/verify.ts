// The TIR verifier (SPEC 4.3): SSA dominance, one terminator per block, types of every operation.
import {
  buildCfg,
  edgesOf,
  FLOAT_TYPES,
  INT_TYPES,
  INTRINSICS,
  opShape,
  type Block,
  type Func,
  type Instr,
  type Module,
  type TirType,
} from "./ir.ts";

export function verifyModule(m: Module): string[] {
  const errors: string[] = [];
  const funcs = new Map<string, Func>();
  for (const f of m.funcs) {
    if (funcs.has(f.name)) errors.push(`duplicate function @${f.name}`);
    funcs.set(f.name, f);
  }
  const globals = new Set(m.globals.map((g) => g.name));
  const traps = new Set(m.traps.map((t) => t.id));
  for (const f of m.funcs) verifyFunc(m, f, funcs, globals, traps, errors);
  return errors;
}

/** One function, against the module it's in: what the optimiser checks after changing that function alone. */
export function verifyFuncIn(m: Module, f: Func): string[] {
  const errors: string[] = [];
  const funcs = new Map<string, Func>();
  for (const g of m.funcs) funcs.set(g.name, g);
  verifyFunc(
    m,
    f,
    funcs,
    new Set(m.globals.map((g) => g.name)),
    new Set(m.traps.map((t) => t.id)),
    errors,
  );
  return errors;
}

function verifyFunc(
  m: Module,
  f: Func,
  funcs: Map<string, Func>,
  globals: Set<string>,
  traps: Set<number>,
  errors: string[],
): void {
  const err = (why: string): void => {
    errors.push(`@${f.name}: ${why}`);
  };
  if (f.blocks.length === 0) {
    err("no blocks");
    return;
  }
  if (f.blocks[0]!.params.length !== 0) err("the entry block has parameters");
  const byId = new Map<number, number>();
  f.blocks.forEach((b, i) => {
    if (byId.has(b.id)) err(`duplicate block bb${b.id}`);
    byId.set(b.id, i);
  });
  for (const b of f.blocks) {
    for (const e of edgesOf(b.term)) {
      if (!byId.has(e.block)) err(`bb${b.id} branches to unknown bb${e.block}`);
    }
  }
  if (errors.length > 0) return;

  const cfg = buildCfg(f);
  if (cfg.rpo.length !== f.blocks.length) err("unreachable blocks");
  // Where each value is defined: block position and instruction index, -1 for block parameters.
  // R36: by value number in arrays, not Maps (the verifier runs on every module, after the optimiser too)
  const defBlock: (number | undefined)[] = Array<number | undefined>(f.types.length); // that many empty slots
  const defIndex: (number | undefined)[] = Array<number | undefined>(f.types.length);
  const define = (v: number, block: number, index: number): void => {
    if (defBlock[v] !== undefined) err(`%${v} is defined twice`);
    if (f.types[v] === undefined) err(`%${v} has no type`);
    defBlock[v] = block;
    defIndex[v] = index;
  };
  for (const p of f.params) define(p, 0, -2);
  f.blocks.forEach((b, at) => {
    for (const p of b.params) define(p, at, -1);
    b.instrs.forEach((ins, i) => {
      for (const r of ins.res) define(r, at, i);
    });
  });
  // a dominates b exactly when b's interval in a walk of the dominator tree is inside a's.
  const children: number[][] = f.blocks.map(() => []);
  for (const [b, d] of cfg.idom) if (b !== d) children[d]!.push(b);
  const pre = new Int32Array(f.blocks.length).fill(-1);
  const post = new Int32Array(f.blocks.length).fill(-1);
  {
    let clock = 0;
    const root = cfg.rpo[0]!;
    const stack: { b: number; i: number }[] = [{ b: root, i: 0 }];
    pre[root] = clock++;
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const kids = children[top.b]!;
      if (top.i < kids.length) {
        const k = kids[top.i++]!;
        pre[k] = clock++;
        stack.push({ b: k, i: 0 });
      } else {
        post[top.b] = clock++;
        stack.pop();
      }
    }
  }
  const dominates = (a: number, b: number): boolean =>
    pre[a]! >= 0 && pre[b]! >= 0 && pre[a]! <= pre[b]! && post[b]! <= post[a]!;
  const useAt = (v: number, at: number, index: number): TirType | null => {
    const d = defBlock[v];
    if (d === undefined) {
      err(`use of undefined %${v}`);
      return null;
    }
    const ok = d === at ? defIndex[v]! < index : dominates(d, at);
    if (!ok) err(`%${v} does not dominate its use in bb${f.blocks[at]!.id}`);
    return f.types[v] ?? null;
  };
  f.blocks.forEach((b, at) => {
    b.instrs.forEach((ins, i) => {
      verifyInstr(m, f, b, at, i, ins, funcs, globals, traps, useAt, err);
    });
    verifyTerm(f, b, at, byId, traps, useAt, err);
  });
}

function checkArg(
  v: number,
  want: TirType | "any-int" | "any-float" | "any",
  got: TirType | null,
  err: (s: string) => void,
  op: string,
): void {
  if (got === null || want === "any") return;
  if (want === "any-int") {
    if (!INT_TYPES.includes(got)) err(`${op}: %${v} is ${got}, expected an integer`);
  } else if (want === "any-float") {
    if (!FLOAT_TYPES.includes(got)) err(`${op}: %${v} is ${got}, expected a float`);
  } else if (want !== got) err(`${op}: %${v} is ${got}, expected ${want}`);
}

function verifyInstr(
  m: Module,
  f: Func,
  b: Block,
  at: number,
  index: number,
  ins: Instr,
  funcs: Map<string, Func>,
  globals: Set<string>,
  traps: Set<number>,
  useAt: (v: number, at: number, index: number) => TirType | null,
  err: (s: string) => void,
): void {
  // R36: one walk over the operands, not a flatMap and a filter
  const vals: number[] = [];
  const others: typeof ins.ops = [];
  for (const o of ins.ops) {
    if (o.t === "v") vals.push(o.id);
    else others.push(o);
  }
  const check = (wants: (TirType | "any-int" | "any-float" | "any")[], rets: TirType[]): void => {
    if (vals.length !== wants.length) {
      err(`${ins.op}: ${vals.length} operands, expected ${wants.length} (bb${b.id})`);
    }
    vals.forEach((v, i) => {
      const want = wants[i];
      if (want !== undefined) checkArg(v, want, useAt(v, at, index), err, ins.op);
    });
    if (ins.res.length !== rets.length) err(`${ins.op}: ${ins.res.length} results`);
    ins.res.forEach((r, i) => {
      if (rets[i] !== undefined && f.types[r] !== rets[i]) {
        err(`${ins.op}: %${r} typed ${f.types[r]!}, expected ${rets[i]!}`);
      }
    });
  };
  if (ins.op === "call") {
    const callee = others[0];
    if (callee?.t !== "sym") {
      err("call without a callee");
      return;
    }
    const ext = m.externs.find((e) => e.name === callee.name);
    if (ext !== undefined) {
      check(ext.params, ext.rets);
      return;
    }
    const target = funcs.get(callee.name);
    if (target === undefined) {
      err(`call to unknown @${callee.name}`);
      return;
    }
    check(
      target.params.map((p) => target.types[p]!),
      target.rets,
    );
    return;
  }
  if (ins.op === "call.indirect") {
    const s = others[0];
    if (s?.t !== "sig" || m.sigs[s.id] === undefined) {
      err("call.indirect without a signature");
      return;
    }
    check(["ptr", ...m.sigs[s.id]!.params], m.sigs[s.id]!.rets);
    return;
  }
  if (ins.op === "intrinsic") {
    const n = others[0];
    const sig = n?.t === "name" ? INTRINSICS[n.name] : undefined;
    if (sig === undefined) {
      err("unknown intrinsic");
      return;
    }
    check(sig.params, sig.rets);
    return;
  }
  const shape = opShape(ins.op);
  if (shape === null) {
    err(`unknown operation ${ins.op}`);
    return;
  }
  check(shape.args, shape.rets);
  if (others.length !== shape.imms.length) {
    err(`${ins.op}: ${others.length} immediates, expected ${shape.imms.length}`);
    return;
  }
  others.forEach((o, i) => {
    const want = shape.imms[i]!;
    const ok =
      (want === "int" && o.t === "i") ||
      (want === "intmax" && (o.t === "i" || o.t === "ixmax")) ||
      want === o.t;
    if (!ok) err(`${ins.op}: immediate ${i} should be ${want}`);
    if (o.t === "trap" && !traps.has(o.id)) err(`${ins.op}: unknown trap t${o.id}`);
    if (o.t === "sym") {
      const known = ins.op === "funcaddr" ? funcs.has(o.name) : globals.has(o.name);
      if (!known) err(`${ins.op}: unknown symbol @${o.name}`);
    }
  });
}

function verifyTerm(
  f: Func,
  b: Block,
  at: number,
  byId: Map<number, number>,
  traps: Set<number>,
  useAt: (v: number, at: number, index: number) => TirType | null,
  err: (s: string) => void,
): void {
  const end = b.instrs.length;
  const t = b.term;
  if (t.k === "brif") {
    const c = useAt(t.cond, at, end);
    if (c !== null && c !== "i32") err(`brif condition %${t.cond} is ${c}`);
  }
  if (t.k === "switch") {
    const c = useAt(t.val, at, end);
    if (c !== null && !INT_TYPES.includes(c)) err(`switch value %${t.val} is ${c}`);
    const seen = new Set<bigint>();
    for (const k of t.cases) {
      if (seen.has(k.key)) err(`switch has duplicate key ${k.key}`);
      seen.add(k.key);
    }
  }
  if (t.k === "ret") {
    if (t.vals.length !== f.rets.length) err(`ret with ${t.vals.length} values in bb${b.id}`);
    t.vals.forEach((v, i) => {
      const ty = useAt(v, at, end);
      if (ty !== null && ty !== f.rets[i]) err(`ret %${v} is ${ty}, expected ${f.rets[i]!}`);
    });
  }
  if (t.k === "trap" && !traps.has(t.id)) err(`unknown trap t${t.id}`);
  for (const e of edgesOf(t)) {
    const target = f.blocks[byId.get(e.block)!]!;
    if (e.args.length !== target.params.length) {
      err(`bb${b.id} passes ${e.args.length} args to bb${e.block}`);
      continue;
    }
    e.args.forEach((v, i) => {
      const ty = useAt(v, at, end);
      const want = f.types[target.params[i]!];
      if (ty !== null && ty !== want) err(`edge to bb${e.block}: %${v} is ${ty}, expected ${want}`);
    });
  }
}
