// Field initialisation order, as JS's (D50): base fields, base constructor body, then derived fields and parameter
// properties after super() returns, then the rest of the derived body. A base constructor that dispatches to an override
// sees the derived fields before they're set. Static members, inherited.
const log: string[] = [];

class Base {
  static created = 0;
  static label(): string {
    return "base";
  }
  a: number = (log.push("Base.a"), 1);
  note: string | undefined;
  constructor() {
    log.push("Base.ctor");
    Base.created++;
    this.hook();
  }
  hook(): void {
    log.push("Base.hook");
  }
}

class Mid extends Base {
  tag: string | undefined = "mid";
  count: number | undefined = 5;
  constructor() {
    super();
    log.push(`Mid.ctor tag=${this.tag} count=${this.count}`);
  }
  override hook(): void {
    log.push(`Mid.hook tag=${this.tag} count=${this.count} a=${this.a}`);
    this.note = "set by hook";
  }
}

class Leaf extends Mid {
  extra: string | undefined = "leaf";
  constructor(public p: number) {
    super();
    log.push(`Leaf.ctor p=${this.p} extra=${this.extra} note=${this.note}`);
  }
  override hook(): void {
    log.push(`Leaf.hook extra=${this.extra} tag=${this.tag}`);
    super.hook();
  }
}

class Plain extends Base {}

export function order(k: number): string {
  log.length = 0;
  if (k === 0) new Base();
  else if (k === 1) new Mid();
  else if (k === 2) new Leaf(7);
  else new Plain();
  return log.join(" | ");
}

export function statics(n: number): string {
  for (let i = 0; i < n; i++) new Plain();
  return `${Base.created} ${Plain.created} ${Leaf.label()} ${Mid.label()}`;
}
