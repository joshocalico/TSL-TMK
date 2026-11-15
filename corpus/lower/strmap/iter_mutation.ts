/* oxlint-disable unicorn/no-useless-spread -- the copy is the point: these delete from what they'd otherwise be going over */
// Mutation during iteration, which JS defines exactly: one parametric program, driven by generated cases over every form
// of iteration, every operation, at every position. A digest of what was visited comes back, and `log` gives the text.
function apply(m: Map<number, number>, op: number, a: number, cur: number, tick: number): void {
  switch (op) {
    case 1:
      m.delete(a);
      break;
    case 2:
      m.set(a, 100 + tick);
      break;
    case 3:
      m.delete(a);
      m.set(a, 200 + tick);
      break;
    case 4:
      m.clear();
      break;
    case 5:
      m.clear();
      m.set(a, 300 + tick);
      m.set(a + 1, 301 + tick);
      break;
    case 6:
      for (let i = 0; i < 9; i++) m.set(50 + i + tick * 100, i);
      break;
    case 7:
      for (const k of [...m.keys()]) m.delete(k);
      for (let i = 0; i < 3; i++) m.set(60 + i, i);
      break;
    case 8:
      m.delete(a);
      for (let i = 0; i < 20; i++) m.set(70 + i, i);
      break;
    case 9: {
      let even = true;
      for (const k of [...m.keys()]) {
        if (even) m.delete(k);
        even = !even;
      }
      for (let i = 0; i < 12; i++) m.set(100 + i, i);
      break;
    }
    case 10:
      m.delete(cur);
      m.set(cur, 400 + tick);
      break;
    case 11:
      m.delete(cur);
      break;
    default:
      break;
  }
}

function applySet(s: Set<number>, op: number, a: number, cur: number, tick: number): void {
  switch (op) {
    case 1:
      s.delete(a);
      break;
    case 2:
      s.add(a);
      break;
    case 3:
      s.delete(a);
      s.add(a);
      break;
    case 4:
      s.clear();
      break;
    case 5:
      s.clear();
      s.add(a);
      s.add(a + 1);
      break;
    case 6:
      for (let i = 0; i < 9; i++) s.add(50 + i + tick * 100);
      break;
    case 7:
      for (const k of [...s]) s.delete(k);
      for (let i = 0; i < 3; i++) s.add(60 + i);
      break;
    case 8:
      s.delete(a);
      for (let i = 0; i < 20; i++) s.add(70 + i);
      break;
    case 9: {
      let even = true;
      for (const k of [...s]) {
        if (even) s.delete(k);
        even = !even;
      }
      for (let i = 0; i < 12; i++) s.add(100 + i);
      break;
    }
    case 10:
      s.delete(cur);
      s.add(cur);
      break;
    case 11:
      s.delete(cur);
      break;
    default:
      break;
  }
}

const LIMIT = 60;

export function logMap(n: number, form: number, op: number, a: number, pos: number): string {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, i * 10);
  let out = "";
  let at = 0;
  const visit = (k: number, v: number): boolean => {
    out += `${k}:${v} `;
    if (at === pos) apply(m, op, a, k, 0);
    at++;
    return at < LIMIT;
  };
  switch (form) {
    case 0:
      for (const [k, v] of m) if (!visit(k, v)) break;
      break;
    case 1:
      for (const k of m.keys()) if (!visit(k, -1)) break;
      break;
    case 2:
      for (const v of m.values()) if (!visit(v, -2)) break;
      break;
    case 3:
      for (const [k, v] of m.entries()) if (!visit(k, v)) break;
      break;
    case 4:
      for (const e of m) if (!visit(e[0], e[1])) break;
      break;
    case 5:
      m.forEach((v, k) => {
        if (at < LIMIT) visit(k, v);
      });
      break;
    case 6: {
      const it = m.keys();
      for (;;) {
        const r = it.next();
        if (r.done) break;
        if (!visit(r.value, -3)) break;
      }
      // An iterator that has finished stays finished, whatever's added.
      m.set(999, 1);
      out += it.next().done ? "stayed " : "woke ";
      break;
    }
    case 7: {
      const it = m.entries();
      for (;;) {
        const r = it.next();
        if (r.done) break;
        const [k, v] = r.value;
        if (!visit(k, v)) break;
      }
      break;
    }
    case 8: {
      // Two at once, in step: each has to find its own place.
      const x = m.keys();
      const y = m.values();
      for (;;) {
        const p = x.next();
        const q = y.next();
        if (p.done || q.done) break;
        if (!visit(p.value, q.value)) break;
      }
      break;
    }
    default: {
      // Made before the change, and first used after it.
      const late = m.keys();
      apply(m, op, a, 0, 0);
      for (const k of late) if (!visit(k, -4)) break;
      break;
    }
  }
  return `${out}| ${[...m.keys()].join(",")} size ${m.size}`;
}

export function logSet(n: number, form: number, op: number, a: number, pos: number): string {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(i);
  let out = "";
  let at = 0;
  const visit = (k: number): boolean => {
    out += `${k} `;
    if (at === pos) applySet(s, op, a, k, 0);
    at++;
    return at < LIMIT;
  };
  switch (form) {
    case 0:
      for (const k of s) if (!visit(k)) break;
      break;
    case 1:
      for (const k of s.keys()) if (!visit(k)) break;
      break;
    case 2:
      for (const k of s.values()) if (!visit(k)) break;
      break;
    case 3:
      for (const [x, y] of s.entries()) if (!visit(x + y)) break;
      break;
    case 4:
      s.forEach((k) => {
        if (at < LIMIT) visit(k);
      });
      break;
    default: {
      const it = s.values();
      for (;;) {
        const r = it.next();
        if (r.done) break;
        if (!visit(r.value)) break;
      }
      s.add(999);
      out += it.next().done ? "stayed " : "woke ";
      break;
    }
  }
  return `${out}| ${[...s].join(",")} size ${s.size}`;
}

function hash(s: string): number {
  let d = 2166136261;
  for (let i = 0; i < s.length; i++) d = Math.imul(d ^ s.charCodeAt(i), 16777619);
  return d;
}

export function digestMap(n: number, form: number, op: number, a: number, pos: number): number {
  return hash(logMap(n, form, op, a, pos));
}

export function digestSet(n: number, form: number, op: number, a: number, pos: number): number {
  return hash(logSet(n, form, op, a, pos));
}

/** String keys and object values, so the moves in a compaction are of counted references. */
class V {
  constructor(public x: number) {}
}
export function digestCounted(n: number, op: number, pos: number): number {
  const m = new Map<string, V>();
  for (let i = 0; i < n; i++) m.set(`key${i}`, new V(i));
  let out = "";
  let at = 0;
  for (const [k, v] of m) {
    out += `${k}=${v.x} `;
    if (at === pos) {
      if (op === 1) m.delete(k);
      else if (op === 2) m.clear();
      else if (op === 3) {
        for (const q of [...m.keys()]) if (q !== k) m.delete(q);
        for (let i = 0; i < 40; i++) m.set(`more${i}`, new V(1000 + i));
      } else if (op === 4) {
        m.delete(`key${n - 1}`);
        m.set(`key${n - 1}`, new V(7));
      }
    }
    at++;
    if (at >= LIMIT) break;
    if (v.x < -1) break;
  }
  return hash(out);
}
