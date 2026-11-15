// rc-stack: 65536
// A huge map and a huge array of strings, dropped under a 64 KiB stack. The freeing bound has to hold with a cursor.
class Row {
  constructor(public v: number) {}
}
let bigMap = new Map<string, Row>();
let bigSet = new Set<number>();
let strs: string[] = [];
let mapOfMaps = new Map<number, Map<number, string>>();

export function buildMap(n: number): number {
  const m = new Map<string, Row>();
  for (let i = 0; i < n; i++) m.set(`key${i}`, new Row(i));
  bigMap = m;
  return m.size;
}
export function dropMap(): number {
  bigMap = new Map<string, Row>();
  return 0;
}
export function clearMap(): number {
  bigMap.clear();
  return 0;
}
export function buildSet(n: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(i * 3);
  bigSet = s;
  return s.size;
}
export function dropSet(): number {
  bigSet = new Set<number>();
  return 0;
}
export function buildStrs(n: number): number {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push(`string number ${i}`);
  strs = a;
  return a.length;
}
export function dropStrs(): number {
  strs = [];
  return 0;
}
export function buildNested(n: number): number {
  const m = new Map<number, Map<number, string>>();
  for (let i = 0; i < n; i++) {
    const inner = new Map<number, string>();
    for (let j = 0; j < 8; j++) inner.set(j, `v${i}.${j}`);
    m.set(i, inner);
  }
  mapOfMaps = m;
  return m.size;
}
export function dropNested(): number {
  mapOfMaps = new Map<number, Map<number, string>>();
  return 0;
}
export function allocAfter(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = (t + new Row(i).v) | 0;
  return t;
}
