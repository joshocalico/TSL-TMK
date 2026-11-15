// The expected digests of corpus/std/model.ts, by JS's own Map, Set, Array and strings, which share nothing with @tsl/std
// (SPEC 3.10, D43). `--write` regenerates corpus/std/model.cases.json, and otherwise this checks it.
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

function mapModel(seed: number, ops: number, keys: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  const m = new Map<number, number>();
  for (let i = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 16;
    if (op < 7) m.set(k, i);
    else if (op < 10) d.add(m.delete(k) ? 1 : 0);
    else if (op < 13) d.add(m.get(k) ?? 0xffffffff);
    else if (op < 15) d.add(m.has(k) ? 1 : 0);
    else if (r.next() % 64 === 0) m.clear();
    else {
      for (const [a, b] of m) {
        d.add(a);
        d.add(b);
      }
    }
    d.add(m.size);
  }
  for (const [a, b] of m) {
    d.add(a);
    d.add(b);
  }
  return d.h;
}

function setModel(seed: number, ops: number, keys: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  const s = new Set<number>();
  for (let i = 0; i < ops; i++) {
    const k = r.next() % keys;
    const op = r.next() % 8;
    if (op < 4) s.add(k);
    else if (op < 6) d.add(s.delete(k) ? 1 : 0);
    else d.add(s.has(k) ? 1 : 0);
    d.add(s.size);
  }
  for (const a of s) d.add(a);
  return d.h;
}

function vecModel(seed: number, ops: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  const v: number[] = [];
  for (let i = 0; i < ops; i++) {
    const op = r.next() % 16;
    const n = v.length;
    const at = n === 0 ? 0 : r.next() % n;
    if (op < 6) v.push(r.next());
    else if (op < 8 && n > 0) d.add(v.pop()!);
    else if (op < 10) v.splice(at, 0, r.next());
    else if (op < 12 && n > 0) d.add(v.splice(at, 1)[0]!);
    else if (op < 13 && n > 0) {
      d.add(v[at]!);
      const last = v.pop()!;
      if (at < v.length) v[at] = last;
    } else if (op < 14 && n > 0) v[at] = r.next();
    else if (op < 15 && n > 1) {
      const j = (at + 1) % n;
      const t = v[at]!;
      v[at] = v[j]!;
      v[j] = t;
    } else if (r.next() % 32 === 0) v.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    d.add(v.length);
  }
  for (const x of v) d.add(x);
  return d.h;
}

const ALPHABET = "ab c";

function text(r: Rng, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[r.next() % 4]!;
  return s;
}

function addStr(d: Digest, s: string): void {
  d.add(s.length);
  for (let i = 0; i < s.length; i++) d.add(s.charCodeAt(i));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function strModel(seed: number, ops: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  for (let i = 0; i < ops; i++) {
    const a = text(r, r.next() % 24);
    const b = text(r, r.next() % 4);
    addStr(d, a + b);
    const from = r.next() % (a.length + 1);
    const to = from + (r.next() % (a.length - from + 1));
    addStr(d, a.slice(from, to));
    d.add(a.indexOf(b, from) >>> 0);
    d.add(cmp(a, b) >>> 0);
    d.add(a === b ? 1 : 0);
    const parts = a.split(" ");
    d.add(parts.length);
    for (const p of parts) addStr(d, p);
  }
  return d.h;
}

function strKeyModel(seed: number, ops: number): number {
  const r = new Rng(seed);
  const d = new Digest();
  const m = new Map<string, number>();
  for (let i = 0; i < ops; i++) {
    const k = text(r, 1 + (r.next() % 3));
    const op = r.next() % 8;
    if (op < 5) m.set(k, i);
    else if (op < 7) d.add(m.delete(k) ? 1 : 0);
    else d.add(m.get(k) ?? 0xffffffff);
    d.add(m.size);
  }
  for (const [k, v] of m) {
    addStr(d, k);
    d.add(v);
  }
  return d.h;
}

export function modelCases(): { fn: string; args: number[]; expect: number | boolean }[] {
  const out: { fn: string; args: number[]; expect: number | boolean }[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const keys = [4, 16, 64, 256, 1024, 4096][seed % 6]!;
    const ops = 400 * seed;
    out.push({ fn: "mapModel", args: [seed, ops, keys], expect: mapModel(seed, ops, keys) });
    // An ExactMap with nothing changed during forEach and no missing key read is JS's Map too (D47).
    out.push({ fn: "exactModel", args: [seed, ops, keys], expect: mapModel(seed, ops, keys) });
    out.push({ fn: "setModel", args: [seed, ops, keys], expect: setModel(seed, ops, keys) });
    out.push({ fn: "vecModel", args: [seed, 200 * seed], expect: vecModel(seed, 200 * seed) });
    out.push({ fn: "strModel", args: [seed, 20 * seed], expect: strModel(seed, 20 * seed) });
    out.push({ fn: "strKeyModel", args: [seed, 60 * seed], expect: strKeyModel(seed, 60 * seed) });
  }
  out.push({ fn: "usesEveryImport", args: [], expect: true });
  return out;
}

export function casesText(): string {
  return `[\n${modelCases()
    .map((c) => `  ${JSON.stringify(c)}`)
    .join(",\n")}\n]\n`;
}

if (process.argv[1]?.endsWith("std-oracle.ts")) {
  const path = join(ROOT, "corpus/std/model.cases.json");
  if (process.argv.includes("--write")) writeFileSync(path, casesText());
  const same =
    JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) ===
    JSON.stringify(JSON.parse(casesText()));
  console.log(same ? `ok: ${modelCases().length} cases` : "FAIL: the cases aren't what JS says");
  process.exit(same ? 0 : 1);
}
