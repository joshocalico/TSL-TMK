// Resource handling with `using` under throw (SPEC 4.5, D49): disposal in reverse order on every way out, a throw in the
// body, a throw in a disposal with SuppressedError's shape, a null resource, and disposals that see the log.
const log: string[] = [];

class Res {
  constructor(
    public name: string,
    public failOnDispose: boolean,
  ) {
    log.push(`open ${name}`);
  }
  use(n: number): number {
    if (n < 0) throw new RangeError(`${this.name} got ${n}`);
    return n * 2;
  }
  [Symbol.dispose](): void {
    log.push(`close ${this.name}`);
    if (this.failOnDispose) throw new Error(`dispose ${this.name} failed`);
  }
}

function work(n: number, failA: boolean, failB: boolean): number {
  using a = new Res("a", failA);
  using b = new Res("b", failB);
  const x = a.use(n);
  return b.use(x - 3);
}

function describe(e: unknown): string {
  if (e instanceof SuppressedError)
    return `Suppressed(${describe(e.error)} over ${describe(e.suppressed)}): ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function run(n: number, failA: boolean, failB: boolean): string {
  log.length = 0;
  let r: string;
  try {
    r = `ok ${work(n, failA, failB)}`;
  } catch (e) {
    r = describe(e);
  }
  return `${r} [${log.join(", ")}]`;
}

export function loop(n: number): string {
  log.length = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    using r = new Res(`r${i}`, false);
    if (i === 2) continue;
    if (i === 4) break;
    total += r.use(i);
  }
  return `${total} [${log.join(", ")}]`;
}

function maybe(n: number): Res | null {
  return n > 0 ? new Res(`m${n}`, false) : null;
}

export function nullable(n: number): string {
  log.length = 0;
  {
    using m = maybe(n);
    log.push(m === null ? "none" : `have ${m.name}`);
  }
  return log.join(", ");
}

export function uncaught(n: number): number {
  log.length = 0;
  return work(n, false, true);
}
