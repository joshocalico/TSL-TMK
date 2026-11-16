// R13: arrays in `strict` (pile item 7), printed as @tsl/jsrt's arena array, whose buffers come only from the call arena the
// caller resets (D36), with typed arrays made in functions (R9's layout classes and tails), arrays of typed arrays, module
// state made in `__init`, closure values and an export giving an object with a typed array in it. Growth past several
// doublings, holes, pop and shift; a case run after another, over the arena that one left, shows a slot read before
// anything wrote it, and a frame reused by a later call (scramble) an array left on a stack it outlived.
class Item {
  constructor(
    public id: number,
    public weight: number,
  ) {}
}

type Table = { codes: Uint16Array; count: number };

const SCALE = [1.5, 0.25, 3, -2];

function scramble(n: number): number {
  let t = 7;
  for (let i = 0; i < n; i++) t = (t * 31 + i) | 0;
  return t;
}

function squares(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i * i);
  return out;
}

export function grow(n: number): number {
  const a = squares(n | 0);
  scramble(16);
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + a[i]!) | 0;
  const last = a.pop() ?? -1;
  const first = a.shift() ?? -1;
  return s * 4 + a.length + last + first;
}

export function items(n: number): number {
  const list: Item[] = [];
  for (let i = 0; i < (n | 0); i++) list.push(new Item(i, i * 0.5));
  const heavy = list.filter((x) => x.weight > 2);
  let w = 0;
  for (const it of heavy) w += it.weight + it.id;
  const hole: Item[] = [];
  hole[3] = new Item(9, 1);
  return w + heavy.length + (hole[1] === undefined ? 100 : 0) + hole[3]!.id;
}

export function nested(n: number): number {
  const rows: number[][] = [];
  for (let r = 0; r < (n | 0); r++) {
    const row: number[] = [];
    for (let c = 0; c <= r; c++) row.push(r * 10 + c);
    rows.push(row);
  }
  let t = 0;
  for (const row of rows) t = (t + row.length * 1000 + (row[row.length - 1] ?? 0)) | 0;
  return t;
}

function table(n: number): Table {
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) codes[i] = (i * 2654435761) & 0xffff;
  return { codes, count: n };
}

export function tables(n: number): number {
  const all: Uint16Array[] = [];
  for (let i = 0; i < (n | 0); i++) all[i] = table(i + 1).codes;
  const missing = all[(n | 0) + 2] ?? new Uint16Array(3).fill(5);
  let t = missing.length * 7 + missing[0]!;
  for (const c of all) t = (t + c.length + c[c.length - 1]!) | 0;
  return t;
}

export function scaled(n: number): number {
  const work = new Float32Array(8);
  for (let i = 0; i < 8; i++) work[i] = i * SCALE[i & 3]!;
  const big = new Int32Array((n | 0) + 1);
  for (let i = 0; i < big.length; i++) big[i] = i - (n | 0);
  let t = 0;
  for (let i = 0; i < 8; i++) t += work[i]!;
  return t + big[0]! + big[big.length - 1]!;
}

export function picked(n: number, which: number): number {
  const acc: number[] = [];
  const twice = (x: number): void => {
    acc.push(x * 2);
  };
  const neg = (x: number): void => {
    acc.push(-x);
  };
  const f = (which | 0) === 0 ? twice : neg;
  for (let i = 0; i < (n | 0); i++) f(i);
  let t = 0;
  for (const x of acc) t += x;
  return t + acc.length;
}

export function made(n: number): Table {
  const t = table((n | 0) + 1);
  t.count = t.codes.length * 3;
  return t;
}
