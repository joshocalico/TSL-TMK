// memory-pages: 256
// Far more than the page limit goes through: `rc` frees it, and `leak` and `manual` run out, with code 14.
class Row {
  constructor(
    public k: string,
    public v: number,
  ) {}
}
export function churnMaps(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const m = new Map<string, Row>();
    for (let j = 0; j < 40; j++) m.set(`k${j}`, new Row(String(i), j));
    m.delete("k3");
    t += m.size;
  }
  return t;
}
export function churnSets(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = new Set<number>();
    for (let j = 0; j < 100; j++) s.add(j * i);
    t += s.size;
  }
  return t;
}
export function churnStrings(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let j = 0; j < 60; j++) s += String(i + j);
    t += s.split("1").join("xx").length;
  }
  return t;
}
export function longMapChurn(n: number): number {
  const m = new Map<number, string>();
  let t = 0;
  for (let i = 0; i < n; i++) {
    m.set(i, `v${i}`);
    if (i >= 64) m.delete(i - 64);
    t += m.size;
  }
  return t;
}
