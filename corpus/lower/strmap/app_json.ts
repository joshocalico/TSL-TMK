// A JSON-like value, a printer and a parser, all by hand, with no JSON or regular expressions.
type Tag = "null" | "bool" | "num" | "str" | "arr" | "obj";
class J {
  tag: Tag = "null";
  b = false;
  n = 0;
  s = "";
  items: J[] = [];
  keys: Map<string, J> = new Map<string, J>();
}
function jNum(n: number): J {
  const j = new J();
  j.tag = "num";
  j.n = n;
  return j;
}
function jStr(s: string): J {
  const j = new J();
  j.tag = "str";
  j.s = s;
  return j;
}

function quote(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c.charCodeAt(0) < 32) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return `${out}"`;
}

export function printJ(j: J, indent: string): string {
  switch (j.tag) {
    case "null":
      return "null";
    case "bool":
      return j.b ? "true" : "false";
    case "num":
      return String(j.n);
    case "str":
      return quote(j.s);
    case "arr":
      if (j.items.length === 0) return "[]";
      return `[${j.items.map((x) => printJ(x, indent)).join(", ")}]`;
    case "obj": {
      const parts: string[] = [];
      for (const [k, v] of j.keys)
        parts.push(`${indent}  ${quote(k)}: ${printJ(v, `${indent}  `)}`);
      return parts.length === 0 ? "{}" : `{\n${parts.join(",\n")}\n${indent}}`;
    }
  }
}

class P {
  i = 0;
  constructor(public t: string) {}
  ws(): void {
    while (this.i < this.t.length) {
      const c = this.t[this.i]!;
      if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") break;
      this.i++;
    }
  }
  value(): J {
    this.ws();
    if (this.i >= this.t.length) throw new SyntaxError("end of input");
    const c = this.t[this.i]!;
    if (c === "[") return this.arr();
    if (c === "{") return this.obj();
    if (c === '"') return jStr(this.str());
    if (this.t.startsWith("null", this.i)) {
      this.i += 4;
      return new J();
    }
    if (this.t.startsWith("true", this.i) || this.t.startsWith("false", this.i)) {
      const j = new J();
      j.tag = "bool";
      j.b = c === "t";
      this.i += j.b ? 4 : 5;
      return j;
    }
    const start = this.i;
    while (this.i < this.t.length && "+-.eE0123456789".includes(this.t[this.i]!)) this.i++;
    if (start === this.i) throw new SyntaxError(`bad character ${c} at ${start}`);
    return jNum(Number(this.t.slice(start, this.i)));
  }
  str(): string {
    this.i++;
    let out = "";
    while (this.t[this.i] !== '"') {
      if (this.i >= this.t.length) throw new SyntaxError("unterminated string");
      const c = this.t[this.i]!;
      if (c === "\\") {
        this.i++;
        const e = this.t[this.i]!;
        if (e === "u") {
          out += String.fromCharCode(parseInt(this.t.substring(this.i + 1, this.i + 5), 16));
          this.i += 4;
        } else out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else out += c;
      this.i++;
    }
    this.i++;
    return out;
  }
  arr(): J {
    const j = new J();
    j.tag = "arr";
    this.i++;
    this.ws();
    if (this.t[this.i] === "]") {
      this.i++;
      return j;
    }
    for (;;) {
      j.items.push(this.value());
      this.ws();
      const c = this.t[this.i++];
      if (c === "]") return j;
      if (c !== ",") throw new SyntaxError("expected , or ]");
    }
  }
  obj(): J {
    const j = new J();
    j.tag = "obj";
    this.i++;
    this.ws();
    if (this.t[this.i] === "}") {
      this.i++;
      return j;
    }
    for (;;) {
      this.ws();
      const k = this.str();
      this.ws();
      this.i++;
      j.keys.set(k, this.value());
      this.ws();
      const c = this.t[this.i++];
      if (c === "}") return j;
      if (c !== ",") throw new SyntaxError("expected , or }");
    }
  }
}

export function roundTrip(text: string): string {
  return printJ(new P(text).value(), "");
}
export function twice(text: string): boolean {
  const once = roundTrip(text);
  return roundTrip(once) === once;
}
export function sumNums(text: string): number {
  const walk = (j: J): number => {
    if (j.tag === "num") return j.n;
    let t = 0;
    for (const x of j.items) t += walk(x);
    for (const v of j.keys.values()) t += walk(v);
    return t;
  };
  return walk(new P(text).value());
}
