// `rc`'s hard cases with a Map: a value read from an entry, held across code that removes the entry. A borrow here would
// be a dead object in the poisoning build.
class P {
  constructor(public v: number) {}
  next: P | null = null;
}
let gm = new Map<string, P>();
let gs = new Map<string, string>();

function dropIt(k: string): void {
  gm.delete(k);
}
function clearAll(): void {
  gm.clear();
}
function replace(k: string): void {
  gm.set(k, new P(-1));
}
function churn(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t += new P(i).v;
  return t;
}
export function getThenCalleeDeletes(): number {
  gm.set("a", new P(5));
  const p = gm.get("a")!;
  dropIt("a");
  churn(100);
  return p.v;
}
export function getThenClear(): number {
  gm.set("b", new P(6));
  const p = gm.get("b")!;
  clearAll();
  churn(100);
  return p.v;
}
export function getThenOverwrite(): number {
  gm.set("c", new P(7));
  const p = gm.get("c")!;
  replace("c");
  churn(100);
  return p.v + gm.get("c")!.v;
}
function useAfterDrop(p: P, k: string): number {
  dropIt(k);
  churn(50);
  return p.v;
}
export function argFromGet(): number {
  gm.set("d", new P(8));
  return useAfterDrop(gm.get("d")!, "d");
}
export function keyHeldAcrossDelete(): string {
  gs.set(`key${"x".repeat(3)}`, "value");
  const k = gs.keys().next().value!;
  gs.delete(k);
  churn(50);
  return k.slice(1);
}
export function deleteOwnKey(): number {
  const m = new Map<string, number>();
  m.set(`k${1}`, 1);
  for (const k of m.keys()) m.delete(k);
  return m.size;
}
export function selfAssign(): number {
  gm.set("e", new P(9));
  gm.set("e", gm.get("e")!);
  churn(50);
  return gm.get("e")!.v;
}
export function valueOfForOfDeleted(): number {
  const m = new Map<number, P>();
  for (let i = 0; i < 5; i++) m.set(i, new P(i));
  let t = 0;
  for (const [k, v] of m) {
    m.delete(k);
    churn(5);
    t += v.v;
  }
  return t;
}
export function forEachDeletes(): number {
  const m = new Map<number, P>();
  for (let i = 0; i < 5; i++) m.set(i, new P(i * 2));
  let t = 0;
  m.forEach((v, k) => {
    m.clear();
    churn(5);
    t += v.v + k;
  });
  return t;
}
export function iteratorKeepsMapAlive(): number {
  const it = (() => {
    const m = new Map<number, number>([[1, 2]]);
    return m.values();
  })();
  churn(50);
  return it.next().value ?? -1;
}
export function stringFromMapThenCleared(): string {
  gs.set("x", "abc".repeat(30));
  const v = gs.get("x")!;
  gs.clear();
  churn(100);
  return v.slice(0, 5);
}
export function sliceOutlivesParent(): string {
  let keep = "";
  {
    const big = "0123456789".repeat(100);
    keep = big.slice(10, 500);
  }
  churn(100);
  return keep.slice(0, 5);
}
export function viewOfBufferOutlives(): string {
  let s = "";
  let keep = "";
  for (let i = 0; i < 500; i++) {
    s += "ab";
    if (i === 300) keep = s;
  }
  s = "";
  churn(200);
  return keep.slice(-4) + keep.length;
}
export function removedKeyStillValid(): string {
  const s = new Set<string>();
  const k = "some".repeat(20);
  s.add(k);
  s.delete(k);
  churn(30);
  return k.slice(0, 4);
}
