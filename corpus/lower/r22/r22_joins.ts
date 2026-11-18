// R22: `a + b + c` made once where it's short (the printing's strConcat3 in `rc`): every way three strings meet, each part
// empty or not, totals either side of 64 units, literals, variables, module state and choices of them as the third part, and
// third parts that call something (which keep the two joins). Each result is read back unit by unit, weighted by position,
// and its length, so parts joined in the wrong order or a unit lost show.
function digest(s: string): number {
  let t = s.length;
  for (let i = 0; i < s.length; i++) t = (t * 31 + s.charCodeAt(i) * (i + 1)) | 0;
  return t;
}

let tag = "§";
let calls = 0;

function noted(s: string): string {
  calls++;
  return s + calls;
}

/** Literal, choice, literal: the shape `key + sep + value` takes, in a loop whose parts alternate. */
export function keys(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = "key" + (i & 1 ? "-" : "+") + "value";
    t = (t * 7 + digest(s)) | 0;
  }
  return t;
}

/** Parts of every length from 0 to `n`, so totals run through 64 and past it, and any part may be empty. */
export function lengths(n: number): number {
  const base = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_+=";
  let t = 0;
  for (let i = 0; i <= n; i += 3)
    for (let j = 0; j <= n; j += 5) {
      const a = base.slice(0, i);
      const b = base.slice(i % 7, (i % 7) + (j % 11));
      const c = base.slice(j % 13, (j % 13) + (n - j));
      const s = a + b + c;
      t = (t * 31 + digest(s)) | 0;
      const u = a + c + b;
      t = (t * 31 + digest(u)) | 0;
    }
  return t;
}

/** Third parts of each pure kind: a literal, a local, module state, and a choice between two of them. */
export function thirds(n: number): number {
  let t = 0;
  let local = "λ";
  for (let i = 0; i < n; i++) {
    const a = String.fromCharCode(65 + (i % 26));
    const b = String.fromCharCode(97 + (i % 13));
    t = (t * 5 + digest(a + b + "!")) | 0;
    t = (t * 5 + digest(a + b + local)) | 0;
    t = (t * 5 + digest(a + b + tag)) | 0;
    t = (t * 5 + digest(a + b + (i % 3 === 0 ? local : tag))) | 0;
    local = local + b;
    if (local.length > 9) local = local.slice(3);
    if (i % 4 === 0) tag = tag === "§" ? "¶" : "§";
  }
  return t;
}

/** A third part that calls something (and counts its calls) keeps the two joins: the count has to come out right too. */
export function impure(n: number): number {
  let t = 0;
  calls = 0;
  for (let i = 0; i < n; i++) {
    const s = "x" + String.fromCharCode(48 + (i % 10)) + noted("y");
    t = (t * 3 + digest(s)) | 0;
  }
  return (t + calls) | 0;
}

/** Joined strings kept in an array, compared with `===` against the same text made another way, and used as map keys. */
export function kept(n: number): number {
  const out: string[] = [];
  const seen = new Map<string, number>();
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = "<" + String.fromCharCode(48 + (i % 10)) + ">";
    out.push(s);
    seen.set(s, (seen.get(s) ?? 0) + 1);
    if (s === "<" + "0123456789"[i % 10]! + ">") t++;
  }
  for (const s of out) t = (t * 3 + digest(s)) | 0;
  for (const [k, v] of seen) t = (t + digest(k) * v) | 0;
  return t;
}
