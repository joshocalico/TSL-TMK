// A parser with error recovery (SPEC 4.5, D49): a recursive-descent parser for statements of arithmetic that throws a
// ParseError on bad input, and a driver that catches it, records it, skips to the next `;` and carries on.
class ParseError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

class EvalError2 extends Error {
  override name = "EvalError2";
}

type Tok = { kind: "num" | "id" | "op" | "end"; text: string; pos: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === " ") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && src.charAt(j) >= "0" && src.charAt(j) <= "9") j++;
      out.push({ kind: "num", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ((c >= "a" && c <= "z") || c === "_") {
      let j = i;
      while (
        j < src.length &&
        ((src.charAt(j) >= "a" && src.charAt(j) <= "z") || src.charAt(j) === "_")
      )
        j++;
      out.push({ kind: "id", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ("+-*/()=;".includes(c)) {
      out.push({ kind: "op", text: c, pos: i });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character '${c}'`, i);
  }
  out.push({ kind: "end", text: "", pos: src.length });
  return out;
}

class Parser {
  i = 0;
  depth = 0;
  maxDepth = 0;
  vars = new Map<string, number>();
  constructor(public toks: Tok[]) {}
  peek(): Tok {
    return this.toks[this.i]!;
  }
  next(): Tok {
    return this.toks[this.i++]!;
  }
  expect(text: string): void {
    const t = this.next();
    if (t.text !== text)
      throw new ParseError(`expected '${text}' but found '${t.text || "end"}'`, t.pos);
  }
  statement(): string {
    const t = this.peek();
    if (t.kind === "id" && this.toks[this.i + 1]?.text === "=") {
      this.i += 2;
      const v = this.expr();
      this.vars.set(t.text, v);
      return `${t.text}=${v}`;
    }
    return `${this.expr()}`;
  }
  expr(): number {
    let v = this.term();
    while (this.peek().text === "+" || this.peek().text === "-") {
      const op = this.next().text;
      const r = this.term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  term(): number {
    let v = this.atom();
    while (this.peek().text === "*" || this.peek().text === "/") {
      const op = this.next();
      const r = this.atom();
      if (op.text === "/" && r === 0) throw new EvalError2(`division by zero at ${op.pos}`);
      v = op.text === "*" ? v * r : Math.trunc(v / r);
    }
    return v;
  }
  atom(): number {
    this.depth++;
    try {
      if (this.depth > this.maxDepth) this.maxDepth = this.depth;
      if (this.depth > 20) throw new ParseError("nesting too deep", this.peek().pos);
      const t = this.next();
      if (t.kind === "num") return Number(t.text);
      if (t.kind === "id") {
        const v = this.vars.get(t.text);
        if (v === undefined) throw new ParseError(`unknown variable ${t.text}`, t.pos);
        return v;
      }
      if (t.text === "(") {
        const v = this.expr();
        this.expect(")");
        return v;
      }
      if (t.text === "-") return -this.atom();
      throw new ParseError(`unexpected '${t.text || "end"}'`, t.pos);
    } finally {
      this.depth--;
    }
  }
  /** Skips past the next `;`, the recovery point. */
  recover(): void {
    while (this.peek().kind !== "end" && this.next().text !== ";") {
      // skip
    }
  }
}

export function run(src: string): string {
  let toks: Tok[];
  try {
    toks = lex(src);
  } catch (e) {
    return e instanceof ParseError ? `lex error at ${e.pos}: ${e.message}` : "?";
  }
  const p = new Parser(toks);
  const out: string[] = [];
  let errors = 0;
  while (p.peek().kind !== "end") {
    const start = p.i;
    try {
      out.push(p.statement());
      if (p.peek().kind !== "end") p.expect(";");
    } catch (e) {
      errors++;
      if (e instanceof ParseError) out.push(`!${e.name}@${e.pos}: ${e.message}`);
      else if (e instanceof Error) out.push(`!${e.name}: ${e.message}`);
      if (p.i === start) p.next();
      p.recover();
    }
  }
  return `${out.join(" | ")} [errors ${errors}, depth ${p.maxDepth}, open ${p.depth}]`;
}

export function strict(src: string): number {
  const p = new Parser(lex(src));
  const v = p.expr();
  p.expect("");
  return v;
}

export function many(n: number): string {
  let src = "";
  for (let i = 0; i < n; i++) {
    src +=
      i % 4 === 0
        ? `x${i % 3 === 0 ? "" : "q"} = ${i} * (${i} + 1);`
        : i % 4 === 1
          ? `(${i} + ;`
          : i % 4 === 2
            ? `${i} / (x - x);`
            : `x * ${i};`;
  }
  return run(src.replaceAll("xq", "x"));
}
