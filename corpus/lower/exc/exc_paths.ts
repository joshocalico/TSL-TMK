// Exceptions through every kind of frame (SPEC 4.5, D49): closures, methods, constructors, getters, array callbacks,
// Map and Set callbacks, for...of over arrays, maps and sets, and recursion, with counted objects live in each.
class Box {
  items: number[] = [];
  constructor(public limit: number) {
    if (limit < 0) throw new RangeError(`negative limit ${limit}`);
  }
  add(x: number): void {
    if (this.items.length >= this.limit) throw new Error(`full at ${x}`);
    this.items.push(x);
  }
  get total(): number {
    let t = 0;
    for (const x of this.items) {
      if (x === 13) throw new Error("unlucky");
      t += x;
    }
    return t;
  }
}

function attempt(f: () => number): string {
  try {
    return `ok ${f()}`;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : "?";
  }
}

export function viaConstructor(n: number): string {
  return attempt(() => new Box(n).limit);
}

export function viaMethod(n: number): string {
  const b = new Box(3);
  return attempt(() => {
    for (let i = 0; i < n; i++) b.add(i * 2);
    return b.items.length;
  });
}

export function viaGetter(xs: number[]): string {
  const b = new Box(100);
  for (const x of xs) b.add(x);
  return attempt(() => b.total);
}

export function viaMap(n: number): string {
  const xs = [1, 2, 3, 4, 5];
  return attempt(() => {
    const ys = xs.map((x) => {
      if (x === n) throw new Error(`map hit ${x}`);
      return x * 10;
    });
    return ys.reduce((a, b) => a + b, 0);
  });
}

export function viaForEach(n: number): string {
  const seen: string[] = [];
  const r = attempt(() => {
    [3, 1, 4, 1, 5].forEach((x, i) => {
      seen.push(`${i}:${x}`);
      if (i === n) throw new TypeError(`stop at ${i}`);
    });
    return seen.length;
  });
  return `${r} [${seen.join(",")}]`;
}

export function viaMapForEach(n: number): string {
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  const out: string[] = [];
  const r = attempt(() => {
    m.forEach((v, k) => {
      out.push(k);
      if (v === n) throw new Error(`map value ${v}`);
    });
    return out.length;
  });
  return `${r} ${out.join("")} size=${m.size}`;
}

export function viaSetForOf(n: number): string {
  const s = new Set<string>(["x", "yy", "zzz"]);
  let acc = "";
  const r = attempt(() => {
    for (const w of s) {
      acc += w;
      if (w.length === n) throw new Error(`set ${w}`);
    }
    return acc.length;
  });
  return `${r} ${acc}`;
}

export function viaMapForOf(n: number): string {
  const m = new Map<number, string>();
  for (let i = 0; i < 5; i++) m.set(i, "v" + i);
  const r = attempt(() => {
    let k = 0;
    for (const [key, v] of m) {
      if (key === n) throw new Error(`at ${v}`);
      k += key;
    }
    return k;
  });
  return r;
}

function depth(n: number, at: number): number {
  if (n === at) throw new Error(`depth ${n}`);
  if (n === 0) return 0;
  const tmp = [n, n + 1];
  return depth(n - 1, at) + tmp.length;
}

export function viaRecursion(n: number, at: number): string {
  return attempt(() => depth(n, at));
}

export function closureCounter(n: number): string {
  let count = 0;
  const bump = (): number => {
    count++;
    if (count > n) throw new Error(`too many: ${count}`);
    return count;
  };
  const r = attempt(() => bump() + bump() + bump());
  return `${r} count=${count}`;
}

export function nested(n: number): string {
  const log: string[] = [];
  try {
    try {
      log.push("a");
      if (n > 0) throw new Error("inner");
      log.push("b");
    } catch (e) {
      log.push("catch1");
      if (n > 1) throw new RangeError("from catch", { cause: e });
    } finally {
      log.push("fin1");
      if (n > 2) throw new SyntaxError("from finally");
    }
  } catch (e) {
    if (e instanceof Error) {
      log.push(`${e.name}:${e.message}`);
      if (e.cause instanceof Error) log.push(`cause=${e.cause.message}`);
    }
  }
  return log.join(" ");
}

export function rethrow(n: number): string {
  try {
    try {
      if (n === 1) throw new TypeError("t");
      if (n === 2) throw new RangeError("r");
      return "none";
    } catch (e) {
      if (e instanceof TypeError) return "handled type";
      throw e;
    }
  } catch (e) {
    return `outer got ${String(e)}`;
  }
}

export function finallyOverrides(n: number): number {
  for (let i = 0; ; i++) {
    try {
      if (i === n) return i * 100;
      if (i > 5) throw new Error("x");
    } finally {
      if (i === 3) return -3;
      if (n === 9 && i === 6) break;
    }
  }
  return -1;
}

export function escapes(n: number): number {
  const b = new Box(2);
  b.add(n);
  b.add(n + 1);
  b.add(n + 2);
  return b.total;
}
