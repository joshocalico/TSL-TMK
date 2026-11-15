// Values of one type share a struct holding every field that flowed in, so a narrow object that
// reaches JS could show the wider shape's field as 0. V8 shows no such field (SPEC 3.10, 4.5).
// expect-fallback: wide shape-widened
// expect-lowered: optionalIsFine
// expect-lowered: taggedIsFine
type Narrow = { a: number };
type Wide = { a: number; b: number };
export function wide(flag: boolean): Narrow {
  const w: Wide = { a: 1, b: 2 };
  const r: Narrow = w;
  return flag ? r : { a: 3 };
}
type Opt = { a: number; b?: number };
export function optionalIsFine(flag: boolean): Opt {
  const w: Opt = { a: 1, b: 2 };
  return flag ? w : { a: 3 };
}
type Tagged = { k: "x"; a: number } | { k: "y"; b: number };
export function taggedIsFine(flag: boolean): Tagged {
  return flag ? { k: "x", a: 1 } : { k: "y", b: 2 };
}
