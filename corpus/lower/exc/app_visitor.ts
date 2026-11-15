// An AST with visitors (SPEC 4.5, D50): an abstract node class with accept(), a visitor base class whose defaults
// subclasses override, several visitors over one tree, and a visitor that throws to stop early.
abstract class Expr {
  abstract accept(v: Visitor): number;
}

class Lit extends Expr {
  constructor(public value: number) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitLit(this);
  }
}

class Add extends Expr {
  constructor(
    public left: Expr,
    public right: Expr,
  ) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitAdd(this);
  }
}

class Mul extends Expr {
  constructor(
    public left: Expr,
    public right: Expr,
  ) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitMul(this);
  }
}

class Neg extends Expr {
  constructor(public inner: Expr) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitNeg(this);
  }
}

class Let extends Expr {
  constructor(
    public name: string,
    public value: Expr,
    public body: Expr,
  ) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitLet(this);
  }
}

class Ref extends Expr {
  constructor(public name: string) {
    super();
  }
  accept(v: Visitor): number {
    return v.visitRef(this);
  }
}

/** Every node visited, children first; subclasses override what they care about. */
class Visitor {
  visitLit(_n: Lit): number {
    return 1;
  }
  visitAdd(n: Add): number {
    return n.left.accept(this) + n.right.accept(this) + 1;
  }
  visitMul(n: Mul): number {
    return n.left.accept(this) + n.right.accept(this) + 1;
  }
  visitNeg(n: Neg): number {
    return n.inner.accept(this) + 1;
  }
  visitLet(n: Let): number {
    return n.value.accept(this) + n.body.accept(this) + 1;
  }
  visitRef(_n: Ref): number {
    return 1;
  }
}

class Evaluator extends Visitor {
  scope = new Map<string, number>();
  override visitLit(n: Lit): number {
    return n.value;
  }
  override visitAdd(n: Add): number {
    return n.left.accept(this) + n.right.accept(this);
  }
  override visitMul(n: Mul): number {
    return n.left.accept(this) * n.right.accept(this);
  }
  override visitNeg(n: Neg): number {
    return -n.inner.accept(this);
  }
  override visitLet(n: Let): number {
    const saved = this.scope.get(n.name);
    this.scope.set(n.name, n.value.accept(this));
    try {
      return n.body.accept(this);
    } finally {
      if (saved === undefined) this.scope.delete(n.name);
      else this.scope.set(n.name, saved);
    }
  }
  override visitRef(n: Ref): number {
    const v = this.scope.get(n.name);
    if (v === undefined) throw new ReferenceError(`${n.name} is not defined`);
    return v;
  }
}

class Depth extends Visitor {
  override visitAdd(n: Add): number {
    return Math.max(n.left.accept(this), n.right.accept(this)) + 1;
  }
  override visitMul(n: Mul): number {
    return Math.max(n.left.accept(this), n.right.accept(this)) + 1;
  }
  override visitLet(n: Let): number {
    return Math.max(n.value.accept(this), n.body.accept(this)) + 1;
  }
}

class Printer extends Visitor {
  out = "";
  override visitLit(n: Lit): number {
    this.out += String(n.value);
    return 0;
  }
  override visitAdd(n: Add): number {
    this.out += "(";
    n.left.accept(this);
    this.out += " + ";
    n.right.accept(this);
    this.out += ")";
    return 0;
  }
  override visitMul(n: Mul): number {
    n.left.accept(this);
    this.out += "*";
    n.right.accept(this);
    return 0;
  }
  override visitNeg(n: Neg): number {
    this.out += "-";
    return n.inner.accept(this);
  }
  override visitLet(n: Let): number {
    this.out += `let ${n.name} = `;
    n.value.accept(this);
    this.out += " in ";
    return n.body.accept(this);
  }
  override visitRef(n: Ref): number {
    this.out += n.name;
    return 0;
  }
}

class FindFirstNeg extends Visitor {
  override visitNeg(n: Neg): number {
    throw n;
  }
}

function build(seed: number, depth: number): Expr {
  const k = (seed * 7 + depth * 3) % 6;
  if (depth === 0) return k < 3 ? new Lit(seed % 10) : new Ref(k === 3 ? "x" : "y");
  const a = build(seed + 1, depth - 1);
  const b = build(seed + 2, depth - 1);
  if (k === 0) return new Add(a, b);
  if (k === 1) return new Mul(a, b);
  if (k === 2) return new Neg(a);
  if (k === 3) return new Let("x", a, b);
  if (k === 4) return new Let("y", b, a);
  return new Add(new Lit(depth), a);
}

export function analyse(seed: number, depth: number): string {
  const e = new Let("x", new Lit(2), new Let("y", new Lit(3), build(seed, depth)));
  const p = new Printer();
  e.accept(p);
  let value: string;
  try {
    value = String(e.accept(new Evaluator()));
  } catch (err) {
    value = err instanceof ReferenceError ? `error ${err.message}` : "?";
  }
  let neg = "none";
  try {
    e.accept(new FindFirstNeg());
  } catch (found) {
    if (found instanceof Neg) {
      const q = new Printer();
      found.accept(q);
      neg = q.out;
    }
  }
  return `${p.out} => ${value}; nodes ${e.accept(new Visitor())}, depth ${e.accept(new Depth())}, first neg ${neg}`;
}

export function unbound(): number {
  return new Add(new Lit(1), new Ref("z")).accept(new Evaluator());
}
