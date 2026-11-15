// `new Map()` and `new Set()` with no type arguments take their type from where they're going (SPEC 4.5).
class Owner {
  constructor(public n: number) {}
}

class Registry {
  self: Map<string, Owner> = new Map();
  seen: Set<number> = new Set();
  late: Map<number, number> | null = null;
  constructor() {
    this.late = new Map();
  }
}

let reg: Map<string, number>;
let either: Set<string> | null = null;

function made(): Map<number, number> {
  return new Map();
}

function maybe(k: boolean): Set<string> | null {
  return k ? new Set() : null;
}

function sizeOf(m: Map<number, string>, s: Set<string>): number {
  return m.size + s.size;
}

export function field(): number {
  const r = new Registry();
  r.self.set("a", new Owner(4));
  r.seen.add(9);
  r.late!.set(1, 2);
  return r.self.get("a")!.n + r.seen.size + r.late!.get(1)!;
}

export function assigned(): number {
  reg = new Map();
  reg.set("x", 41);
  either = new Set();
  either.add("y");
  return reg.get("x")! + either.size;
}

export function returned(): number {
  const m = made();
  m.set(1, 5);
  const s = maybe(true);
  s!.add("k");
  return m.get(1)! + s!.size;
}

export function argument(): number {
  return sizeOf(new Map(), new Set());
}

export function local(): number {
  const a: Map<string, number> = new Map();
  let b: Set<number>;
  b = new Set();
  a.set("n", 7);
  b.add(1);
  const c: Map<string, number> = a.size > 5 ? a : new Map();
  c.set("m", 1);
  return a.get("n")! + b.size + c.size;
}
