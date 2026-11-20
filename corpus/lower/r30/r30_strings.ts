// R30 (SPEC 3.5, 4.3): what R30's changes rest on, each where a wrong rule gives another answer than V8's:
// - `repeat` of one unit, of several, of a view, of nothing, and long, which `rc` class printing writes by JsStr's
//   repeatFrom (copies that double), and `padStart`/`padEnd`, whose copy of the string is copyFrom's: each result's
//   every unit read back (a digest), not only its length;
// - objects made with fields set by their constructors and after, kept and read back, so each new object's fields are
//   written straight into its slot (scalar replacement of the copy that placed it) on every way a slot comes;
// - work with a call taken only sometimes, many values live across it (values split around cold calls).
function digest(s: string): number {
  let h = s.length;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619) + i) | 0;
  return h;
}

export function repeats(n: number, unit: string, many: string): number {
  let h = 0;
  for (let k = 0; k <= n; k++) {
    h = (h + digest(unit.repeat(k)) + digest(many.repeat(k))) | 0;
    h = (h + digest(("<" + many + ">").repeat((k * 7) % 13))) | 0;
  }
  // a view's units as the source: the slice of a long string built by appends
  let long = "";
  for (let i = 0; i < 60; i++) long += many;
  const view = long.slice(3, 3 + Math.min(45, long.length - 3));
  h = (h + digest(view.repeat(n % 9)) + digest("".repeat(n))) | 0;
  return h;
}

export function longRepeat(n: number, s: string): number {
  const r = s.repeat(n);
  // read a unit from each end and the middle, and the whole
  return (digest(r) + r.length * 31 + (r.length > 0 ? r.charCodeAt(r.length >> 1) : 7)) | 0;
}

export function pads(n: number, s: string, fill: string): number {
  let h = 0;
  for (let k = 0; k < n; k++) {
    h = (h + digest(s.padStart(k, fill)) + digest(s.padEnd(k, fill))) | 0;
    h = (h + digest(s.padStart(k)) + digest((s + s).padEnd(k + 3, fill))) | 0;
  }
  return h;
}

class Rec {
  extra = 0;
  tag = "";
  constructor(
    public a: number,
    public b: number,
    public name: string,
  ) {
    this.extra = a * 2 + b;
  }
}

export function records(n: number): number {
  const keep: Rec[] = [];
  let h = 0;
  for (let i = 0; i < n; i++) {
    const r = new Rec(i, n - i, "r" + i);
    r.tag = i % 3 === 0 ? "x" : "yy";
    if (i % 4 !== 0) keep.push(r);
    h = (h + r.a * 3 + r.b + r.extra + r.name.length + r.tag.length) | 0;
  }
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i]!;
    h = (h + r.a - r.b + r.extra * 5 + digest(r.name) + digest(r.tag)) | 0;
  }
  return h;
}

function rare(a: number, b: number, c: number): number {
  let x = a;
  for (let i = 0; i < 7; i++) x = (Math.imul(x, 31) + b - c * i) | 0;
  return x;
}

export function sometimes(n: number, k: number): number {
  let a = 1;
  let b = 2;
  let c = 3;
  let d = 4;
  let t = 0;
  for (let i = 0; i < n; i++) {
    a = (a + i) | 0;
    b = (b ^ a) | 0;
    c = (c + b * 3) | 0;
    d = (d - c) | 0;
    if (i % k === 0) t = (t + rare(a, b, c) + rare(d, c, b)) | 0;
    t = (t + a + b + c + d) | 0;
  }
  return t;
}
