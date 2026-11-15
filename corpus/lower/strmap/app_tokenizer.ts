// A tokeniser and an evaluator: strings by index, literal-union tags on a class, and numbers by Number().
type Kind = "num" | "id" | "op" | "str" | "eof";
class Token {
  constructor(
    public kind: Kind,
    public text: string,
    public at: number,
  ) {}
}
const KEYWORDS = new Set<string>(["let", "if", "else", "while"]);

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdent(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c > "\u007f";
}

export function tokens(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\n" || c === "\t") {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === "." && i + 1 < src.length && isDigit(src[i + 1]!))) {
      while (i < src.length && (isDigit(src[i]!) || src[i] === ".")) i++;
      if (i < src.length && (src[i] === "e" || src[i] === "E")) {
        i++;
        if (src[i] === "-" || src[i] === "+") i++;
        while (i < src.length && isDigit(src[i]!)) i++;
      }
      out.push(new Token("num", src.slice(start, i), start));
    } else if (isIdent(c)) {
      while (i < src.length && (isIdent(src[i]!) || isDigit(src[i]!))) i++;
      out.push(new Token("id", src.substring(start, i), start));
    } else if (c === '"') {
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          i++;
          const e = src[i]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else s += src[i]!;
        i++;
      }
      i++;
      out.push(new Token("str", s, start));
    } else {
      const two = src.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        out.push(new Token("op", two, start));
        i += 2;
      } else {
        out.push(new Token("op", c, start));
        i++;
      }
    }
  }
  out.push(new Token("eof", "", src.length));
  return out;
}

export function summary(src: string): string[] {
  return tokens(src).map((t) => `${t.kind}:${KEYWORDS.has(t.text) ? "kw:" : ""}${t.text}@${t.at}`);
}

class Parser {
  pos = 0;
  vars = new Map<string, number>();
  constructor(public toks: Token[]) {}
  peek(): Token {
    return this.toks[this.pos]!;
  }
  eat(): Token {
    return this.toks[this.pos++]!;
  }
  atom(): number {
    const t = this.eat();
    if (t.kind === "num") return Number(t.text);
    if (t.kind === "id") return this.vars.get(t.text) ?? 0;
    if (t.text === "(") {
      const v = this.sum();
      this.eat();
      return v;
    }
    if (t.text === "-") return -this.atom();
    throw new Error(`unexpected ${t.text} at ${t.at}`);
  }
  product(): number {
    let v = this.atom();
    for (;;) {
      const t = this.peek();
      if (t.text === "*") {
        this.eat();
        v *= this.atom();
      } else if (t.text === "/") {
        this.eat();
        v /= this.atom();
      } else return v;
    }
  }
  sum(): number {
    let v = this.product();
    for (;;) {
      const t = this.peek();
      if (t.text === "+") {
        this.eat();
        v += this.product();
      } else if (t.text === "-") {
        this.eat();
        v -= this.product();
      } else return v;
    }
  }
}

export function evaluate(src: string): number {
  const p = new Parser(tokens(src));
  p.vars.set("pi", 3.25);
  p.vars.set("été", 2);
  return p.sum();
}

export function show(src: string): string {
  return `${src} = ${evaluate(src)}`;
}
