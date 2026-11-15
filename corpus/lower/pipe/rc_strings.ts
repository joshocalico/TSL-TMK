// memory-pages: 256
// R10 (SPEC 3.5, 4.5's ABI in `rc`, D39, D42): strings in `rc` through both routes, the TSL route's the program's own
// JsStr, counted by tslc's expansion. Literals, template literals, concatenation that appends in place and prepends,
// slices that share a buffer and copies, comparison, strings as map keys, in arrays, in class fields and in objects that
// form cycles (which the collector frees with their strings), a string kept in module state and given back, and strings
// crossing an export both ways: a caller places each argument (one count, its own) and lets go of each result.
class Person {
  constructor(
    public name: string,
    public age: number,
  ) {}
}

class Tag {
  next: Tag | null = null;
  constructor(public label: string) {}
}

class Box {
  constructor(public v: number) {}
}

let kept: string | null = null;
let many: string[] = [];
let box: Box | null = null;

/** The argument, given back: the caller holds two counts on it then. */
export function echo(s: string): string {
  return s;
}

/** A literal, given back. */
export function hello(): string {
  return "hello";
}

/** A template literal: literals and the argument. */
export function greet(name: string): string {
  return `Hello, ${name}! Bye, ${name}.`;
}

/** Appends in a loop, through a buffer, and a prepend; number text. */
export function build(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += "<" + i + ">";
  let pre = "!";
  for (let i = 0; i < n; i++) pre = "ab" + pre;
  return out + "|" + pre.length;
}

/** Two strings grown from one prefix: each must append in its own place. */
export function branches(s: string, n: number): string {
  let base = "";
  for (let i = 0; i < n; i++) base += s;
  const x = base + "X";
  const y = base + "Y";
  return x + "/" + y + "/" + (x + "Z");
}

/** Slices of a long string that share its buffer, and short ones that copy. */
export function slices(s: string, n: number): string {
  let big = "";
  for (let i = 0; i < n; i++) big += s;
  let out = "";
  for (let k = 0; k + 40 <= big.length; k += 13)
    out += big.slice(k, k + 40).length + big.slice(k, k + 3) + ";";
  const mid = big.substring(1, big.length - 1);
  return out + mid.slice(2, 50) + big.slice(-5);
}

/** By code unit, as JS orders strings. */
export function compare(a: string, b: string): number {
  return (a === b ? 100 : 0) + (a < b ? 10 : 0) + (a > b ? 1 : 0);
}

/** Words counted in a map with string keys: how many distinct, and the most of one. */
export function words(text: string): number {
  const counts = new Map<string, number>();
  let w = "";
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charAt(i) : " ";
    if (c === " ") {
      if (w.length > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
      w = "";
    } else w += c;
  }
  let most = 0;
  counts.forEach((v) => {
    if (v > most) most = v;
  });
  return counts.size * 1000 + most;
}

/** Strings in class fields and in an array of objects. */
export function people(n: number): string {
  const xs: Person[] = [];
  for (let i = 0; i < n; i++) xs.push(new Person("p" + i, 20 + i));
  let out = "";
  for (const p of xs) out += p.name + ":" + p.age + " ";
  return out;
}

/** An array of strings, built, sorted by hand and joined. */
export function sorted(s: string): string {
  const xs: string[] = [];
  let w = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === ",") {
      xs.push(w);
      w = "";
    } else w += c;
  }
  xs.push(w);
  for (let i = 1; i < xs.length; i++)
    for (let j = i; j > 0 && xs[j - 1]! > xs[j]!; j--) {
      const t = xs[j]!;
      xs[j] = xs[j - 1]!;
      xs[j - 1] = t;
    }
  let out = "";
  for (const x of xs) out += "[" + x + "]";
  return out;
}

/** A ring of objects each holding a string: garbage once it returns, which only the collector frees. */
export function ring(n: number): number {
  const head = new Tag("t0");
  let last = head;
  for (let i = 1; i < n; i++) {
    const t = new Tag("t" + i + "-" + "x".repeat(i % 5));
    last.next = t;
    last = t;
  }
  last.next = head;
  let len = 0;
  let p: Tag | null = head;
  for (let i = 0; i < n && p !== null; i++) {
    len += p.label.length;
    p = p.next;
  }
  return len;
}

/** By code point, and each unit's string. */
export function chars(s: string): string {
  let out = "";
  for (const c of s) out = c + out;
  let codes = 0;
  for (let i = 0; i < s.length; i++) codes = (codes * 31 + s.charCodeAt(i)) % 100003;
  return out + "#" + codes;
}

/** A string the caller placed, kept in module state past the call. */
export function keep(s: string): number {
  kept = s;
  return s.length;
}

/** What's kept, given back with a count of the caller's. */
export function readKept(): string {
  return kept ?? "none";
}

/** Let go of what's kept. */
export function dropKept(): number {
  kept = null;
  return 0;
}

/** Many strings in module state, each its own. */
export function keepMany(n: number): number {
  many = [];
  for (let i = 0; i < n; i++) many.push("s" + i);
  return many.length;
}

/** Let go of them all at once: freed a bounded number of steps at a time (D39). */
export function dropMany(): number {
  many = [];
  return 0;
}

/** One allocation, which takes its freeing steps, let go of again. */
export function one(v: number): number {
  box = new Box(v);
  const r = box.v;
  box = null;
  return r;
}
