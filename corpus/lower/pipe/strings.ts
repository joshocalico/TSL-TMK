// Strings printed as @tsl/jsrt's JsString (D67): literals as readable text, `length`, indexing, concatenation that
// appends in place and shares a tail, substrings that share within their bound and copy outside it, `for...of` by code
// point, equality and order by code unit, and the runtime's other string functions over the class's units. With
// non-ASCII, emoji (a surrogate pair), lone surrogates and empty strings, in arguments, literals and results.
export function echo(s: string): string {
  return s;
}

export function lengths(a: string, b: string): number {
  return a.length * 1000 + b.length;
}

export function joinAll(a: string, b: string): string {
  return a + "|" + b + "|é😀|" + "\ud800" + "!";
}

export function appendLoop(s: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += s;
  return out;
}

/** Two strings built from one shared prefix: each append must land in its own place, not in the other's. */
export function branches(s: string, n: number): string {
  let base = "";
  for (let i = 0; i < n; i++) base += s;
  const x = base + "X";
  const y = base + "Y";
  const z = x + "Z";
  return x + "/" + y + "/" + z + "/" + base;
}

/** Substrings of every length around the sharing bound, of a flat string and of a view. */
export function subs(s: string, n: number): string {
  let big = "";
  for (let i = 0; i < n; i++) big += s;
  let out = "";
  for (let k = 0; k <= big.length; k += 7) {
    out += big.slice(k, k + 40) + "," + big.substring(k >> 1, k) + ";";
  }
  const v = big.slice(1, big.length - 1);
  return out + v.slice(2, 50) + v.substring(0, 33) + v.slice(-3);
}

export function codes(s: string): number {
  let t = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s.charCodeAt(i);
    t = (t * 31 + (c === c ? c : 7)) % 1000003;
  }
  return t;
}

/** `for...of` steps by code point: a pair is one step, a lone surrogate one too. */
export function points(s: string): string {
  let out = "";
  let n = 0;
  for (const c of s) {
    out += c.length === 2 ? "[" + c + "]" : c;
    n++;
  }
  return out + "#" + String.fromCharCode(48 + n);
}

export function compare(a: string, b: string): number {
  return (a === b ? 100 : 0) + (a < b ? 10 : 0) + (a > b ? 1 : 0);
}

export function chars(s: string): string {
  let out = "";
  for (let i = s.length - 1; i >= 0; i--) out += s.charAt(i) + s[i]!;
  return out;
}

export function search(s: string, p: string): number {
  return (
    s.indexOf(p) * 1000 +
    s.lastIndexOf(p) +
    (s.includes(p) ? 0.5 : 0) +
    (s.startsWith(p) ? 0.25 : 0)
  );
}

export function parts(s: string): string {
  const xs = s.split(",");
  let out = "";
  for (const x of xs) out += "<" + x.trim() + ">";
  return out + (xs.length > 2 ? "many" : "few");
}

export function cases(s: string): string {
  return s.toUpperCase() + s.toLowerCase();
}

export function pad(s: string, n: number): string {
  return s.padStart(n, "é") + s.padEnd(n, "😀") + s.repeat(3);
}

export function code(n: number): string {
  return String.fromCharCode(n) + String.fromCharCode(n + 1);
}
