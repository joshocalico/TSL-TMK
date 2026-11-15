// An interpreter that uses exceptions for `return` and `break` (SPEC 4.5, D49, D50): signals are objects of classes
// that aren't Errors, thrown through the evaluator's recursion and caught where a call or a loop handles them, while real
// errors pass through to the caller.
abstract class Node {
  abstract run(env: Env): number;
}

class Env {
  vars = new Map<string, number>();
  funcs = new Map<string, Fn>();
  depth = 0;
  steps = 0;
}

class ReturnSignal {
  constructor(public value: number) {}
}
class BreakSignal {}
class ScriptError extends Error {
  override name = "ScriptError";
}

class Num extends Node {
  constructor(public v: number) {
    super();
  }
  run(): number {
    return this.v;
  }
}
class Var extends Node {
  constructor(public name: string) {
    super();
  }
  run(env: Env): number {
    const v = env.vars.get(this.name);
    if (v === undefined) throw new ScriptError(`undefined ${this.name}`);
    return v;
  }
}
class Bin extends Node {
  constructor(
    public op: string,
    public l: Node,
    public r: Node,
  ) {
    super();
  }
  run(env: Env): number {
    const a = this.l.run(env);
    const b = this.r.run(env);
    if (this.op === "+") return a + b;
    if (this.op === "-") return a - b;
    if (this.op === "*") return a * b;
    if (this.op === "<") return a < b ? 1 : 0;
    if (b === 0) throw new ScriptError("divide by zero");
    return Math.trunc(a / b);
  }
}
class Assign extends Node {
  constructor(
    public name: string,
    public e: Node,
  ) {
    super();
  }
  run(env: Env): number {
    const v = this.e.run(env);
    env.vars.set(this.name, v);
    return v;
  }
}
class Seq extends Node {
  constructor(public body: Node[]) {
    super();
  }
  run(env: Env): number {
    let v = 0;
    for (const s of this.body) v = s.run(env);
    return v;
  }
}
class While extends Node {
  constructor(
    public cond: Node,
    public body: Node,
  ) {
    super();
  }
  run(env: Env): number {
    let n = 0;
    try {
      while (this.cond.run(env) !== 0) {
        if (++env.steps > 10000) throw new ScriptError("too many steps");
        this.body.run(env);
        n++;
      }
    } catch (e) {
      if (!(e instanceof BreakSignal)) throw e;
    }
    return n;
  }
}
class If extends Node {
  constructor(
    public cond: Node,
    public then: Node,
  ) {
    super();
  }
  run(env: Env): number {
    return this.cond.run(env) !== 0 ? this.then.run(env) : 0;
  }
}
class Break extends Node {
  run(): number {
    throw new BreakSignal();
  }
}
class Return extends Node {
  constructor(public e: Node) {
    super();
  }
  run(env: Env): number {
    throw new ReturnSignal(this.e.run(env));
  }
}
class Fn {
  constructor(
    public param: string,
    public body: Node,
  ) {}
}
class Call extends Node {
  constructor(
    public name: string,
    public arg: Node,
  ) {
    super();
  }
  run(env: Env): number {
    const f = env.funcs.get(this.name);
    if (f === undefined) throw new ScriptError(`no function ${this.name}`);
    const arg = this.arg.run(env);
    const saved = env.vars.get(f.param);
    env.vars.set(f.param, arg);
    env.depth++;
    try {
      if (env.depth > 50) throw new ScriptError("recursion too deep");
      f.body.run(env);
      return 0;
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      env.depth--;
      if (saved !== undefined) env.vars.set(f.param, saved);
      else env.vars.delete(f.param);
    }
  }
}

const n = (v: number): Node => new Num(v);
const v = (s: string): Node => new Var(s);
const bin = (op: string, l: Node, r: Node): Node => new Bin(op, l, r);

function program(k: number): Env {
  const env = new Env();
  // fact(x): if (x < 2) return 1; return x * fact(x - 1)
  env.funcs.set(
    "fact",
    new Fn(
      "x",
      new Seq([
        new If(bin("<", v("x"), n(2)), new Return(n(1))),
        new Return(bin("*", v("x"), new Call("fact", bin("-", v("x"), n(1))))),
      ]),
    ),
  );
  // firstOver(x): i = 0; while (1) { i = i + 1; if (x < i * i) break; } return i
  env.funcs.set(
    "firstOver",
    new Fn(
      "x",
      new Seq([
        new Assign("i", n(0)),
        new While(
          n(1),
          new Seq([
            new Assign("i", bin("+", v("i"), n(1))),
            new If(bin("<", v("x"), bin("*", v("i"), v("i"))), new Break()),
          ]),
        ),
        new Return(v("i")),
      ]),
    ),
  );
  env.funcs.set("loop", new Fn("x", new Return(new Call("loop", v("x")))));
  env.funcs.set("bad", new Fn("x", new Return(bin("/", v("x"), n(k)))));
  return env;
}

export function call(name: string, arg: number, k: number): string {
  const env = program(k);
  try {
    return `${name}(${arg}) = ${new Call(name, n(arg)).run(env)} depth=${env.depth}`;
  } catch (e) {
    if (e instanceof ScriptError)
      return `${e.name}: ${e.message} depth=${env.depth} vars=${env.vars.size}`;
    return "escaped";
  }
}

export function raw(name: string, arg: number): number {
  return new Call(name, n(arg)).run(program(0));
}
