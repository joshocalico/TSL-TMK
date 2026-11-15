// The expected results of corpus/std/map_js.ts, by JS's own Map and Set, which share nothing with @tsl/std (SPEC 3.10, D47):
// that `@tsl/std`'s Map and Set are JS's, in `get` and under change during `forEach`. `--write` regenerates
// corpus/std/map_js.cases.json, and otherwise this checks it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

class Rng {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  next(): number {
    this.x = (Math.imul(this.x, 1664525) + 1013904223) >>> 0;
    return this.x >>> 8;
  }
}

class Digest {
  h = 0x811c9dc5;
  add(x: number): void {
    this.h = Math.imul((this.h ^ x) >>> 0, 0x01000193) >>> 0;
  }
}

function change(m: Map<number, number>, n: number, op: number, a: number): void {
  if (op === 0) m.set(a * 10, 99);
  else if (op === 1) m.set(1000 + a, 7);
  else if (op === 2) m.delete(a * 10);
  else if (op === 3) {
    m.delete(a * 10);
    m.set(a * 10, 5);
  } else if (op === 4) m.clear();
  else if (op === 5) {
    m.clear();
    m.set(77, 1);
    m.set(78, 2);
  } else if (op === 6) {
    for (let j = 0; j < 20; j++) m.set(2000 + j, j);
  } else if (op === 7) {
    for (let j = 0; j < n; j++) m.delete(j * 10);
    for (let j = 0; j < 12; j++) m.set(3000 + j, j);
  } else if (op === 8) {
    for (let j = 0; j < n; j += 2) m.delete(j * 10);
    for (let j = 0; j < 9; j++) m.set(4000 + j, j);
  }
}

function mutateDuring(n: number, op: number, a: number, pos: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i * 10, i);
  const d = new Digest();
  let at = 0;
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
    if (at === pos) change(m, n, op, a);
    at++;
  });
  d.add(m.size);
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
  });
  return d.h;
}

function mutateNested(n: number, op: number, a: number, pos: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i * 10, i);
  const d = new Digest();
  let at = 0;
  m.forEach((v, k) => {
    d.add((k + v) >>> 0);
    let inner = 0;
    m.forEach((w, j) => {
      d.add(j);
      d.add(w);
      if (at === pos && inner === 1) change(m, n, op, a);
      inner++;
    });
    at++;
  });
  d.add(m.size);
  return d.h;
}

function setMutateDuring(n: number, op: number, a: number, pos: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(i);
  const d = new Digest();
  let at = 0;
  s.forEach((k) => {
    d.add(k);
    if (at === pos) {
      if (op === 0) s.add(100 + a);
      else if (op === 1) s.delete(a);
      else if (op === 2) {
        s.delete(a);
        s.add(a);
      } else if (op === 3) s.clear();
      else if (op === 4) {
        s.clear();
        s.add(50);
      } else if (op === 5) {
        for (let j = 0; j < 20; j++) s.add(200 + j);
      }
    }
    at++;
  });
  d.add(s.size);
  return d.h;
}

function getMissing(n: number, k: number): number {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 3);
  const v = m.get(k);
  if (v === undefined) return 1000000 + (m.get(k + 1) ?? 7);
  return v + (m.get(k) !== undefined ? 1 : 0);
}

function getMissingRef(n: number, k: number): number {
  const m = new Map<number, string>();
  for (let i = 0; i < n; i++) m.set(i, String(i * 11));
  const s = m.get(k);
  return s === undefined ? 77 : s.length * 100 + s.charCodeAt(0);
}

function randomJs(seed: number, ops: number, keys: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  const m = new Map<number, number>();
  for (let i = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 16;
    if (op < 6) m.set(k, i);
    else if (op < 9) d.add(m.delete(k) ? 1 : 0);
    else if (op < 12) d.add(m.get(k) ?? 0xffffffff);
    else if (op < 13) d.add(m.has(k) ? 1 : 0);
    else if (op < 14 && r.next() % 32 === 0) m.clear();
    else {
      const every = 1 + (r.next() % 4);
      const what = r.next() % 4;
      let at = 0;
      m.forEach((v, key) => {
        d.add(key);
        d.add(v);
        if (at % every === 0) {
          if (what === 0) m.set(keys + at, at);
          else if (what === 1) m.delete(key);
          else if (what === 2) m.delete((key + 1) % keys);
          else m.set((key + 3) % keys, (v + 1) >>> 0);
        }
        at++;
        if (at > 4 * keys) m.clear();
      });
    }
    d.add(m.size);
  }
  m.forEach((v, k) => {
    d.add(k);
    d.add(v);
  });
  return d.h;
}

export function mapJsCases(): { fn: string; args: number[]; expect: number | boolean }[] {
  const out: { fn: string; args: number[]; expect: number | boolean }[] = [];
  for (const n of [0, 1, 3, 4, 5, 9])
    for (let op = 0; op <= 8; op++)
      for (const a of n === 0 ? [0] : [0, n >> 1, n - 1, n + 2])
        for (let pos = 0; pos <= n; pos++) {
          out.push({
            fn: "mutateDuring",
            args: [n, op, a, pos],
            expect: mutateDuring(n, op, a, pos),
          });
          if (n > 1 && pos < n)
            out.push({
              fn: "mutateNested",
              args: [n, op, a, pos],
              expect: mutateNested(n, op, a, pos),
            });
        }
  for (const n of [0, 1, 3, 4, 6])
    for (let op = 0; op <= 5; op++)
      for (const a of n === 0 ? [0] : [0, n >> 1, n - 1])
        for (let pos = 0; pos <= n; pos++)
          out.push({
            fn: "setMutateDuring",
            args: [n, op, a, pos],
            expect: setMutateDuring(n, op, a, pos),
          });
  for (const [n, k] of [
    [0, 0],
    [5, 2],
    [5, 5],
    [5, 4],
    [40, 39],
    [40, 41],
  ] as const) {
    out.push({ fn: "getMissing", args: [n, k], expect: getMissing(n, k) });
    out.push({ fn: "getMissingRef", args: [n, k], expect: getMissingRef(n, k) });
  }
  for (let seed = 1; seed <= 16; seed++) {
    const keys = [4, 8, 16, 64, 256][seed % 5]!;
    out.push({
      fn: "randomJs",
      args: [seed, 150 * seed, keys],
      expect: randomJs(seed, 150 * seed, keys),
    });
  }
  out.push({ fn: "usesEveryImport", args: [], expect: true });
  return out;
}

export function mapJsCasesText(): string {
  return `[\n${mapJsCases()
    .map((c) => `  ${JSON.stringify(c)}`)
    .join(",\n")}\n]\n`;
}

if (process.argv[1]?.endsWith("std-map-oracle.ts")) {
  const path = join(ROOT, "corpus/std/map_js.cases.json");
  if (process.argv.includes("--write")) writeFileSync(path, mapJsCasesText());
  const same =
    JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) ===
    JSON.stringify(JSON.parse(mapJsCasesText()));
  console.log(same ? `ok: ${mapJsCases().length} cases` : "FAIL: the cases aren't what JS says");
  process.exit(same ? 0 : 1);
}
