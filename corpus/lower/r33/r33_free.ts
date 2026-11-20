// R33: freeing in `rc` with no collector linked (no class here can be in a cycle), where no release function can reach
// `stepping`, so @tsl/gc doesn't set it around release calls, and where strings' release functions reach `spare` (a view's
// buffer given back at once where the budget has a step to spare), so it's still set around theirs. Strings are freed far
// more often than the program's own classes, which come first in the order the program shows them, so the release dispatch
// reaches a string's release function first. Arrays of strings, views and objects holding strings are let go of at once,
// so freeing runs on over many allocations with the cursor on a large array; what's kept past it is read again, so a block
// given back twice, a step skipped or the wrong release function called shows.
class Person {
  constructor(
    public name: string,
    public age: number,
  ) {}
}

class Pair {
  constructor(
    public a: Person,
    public b: Person,
  ) {}
}

class Note {
  constructor(public text: string) {}
}

function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

/** Strings made and let go of, views of a long one among them: some kept in a second array, read after the first goes. */
export function words(n: number): number {
  let long = "";
  for (let i = 0; i < n; i++) long += String.fromCharCode(97 + (i % 26));
  const all: string[] = [];
  const keep: string[] = [];
  for (let i = 0; i + 3 <= long.length; i++) {
    const w = i % 3 === 0 ? long.slice(i, i + 3) : "w" + i;
    all.push(w);
    if (i % 5 === 0) keep.push(w);
  }
  let h = mix(0, all.length);
  all.length = 0;
  for (let i = 0; i < n; i++) h = mix(h, codeOf("t" + i));
  for (const k of keep) h = mix(h, codeOf(k));
  return h;
}

/** People holding names, in pairs, the pairs let go of at once; some people kept and read after. */
export function people(n: number): number {
  const pairs: Pair[] = [];
  const kept: Person[] = [];
  for (let i = 0; i < n; i++) {
    const a = new Person("p" + i, i);
    const b = new Person(i % 2 === 0 ? "q" + i : "r" + i * 7, i + 1);
    pairs.push(new Pair(a, b));
    if (i % 4 === 1) kept.push(b);
  }
  let h = mix(0, pairs.length);
  pairs.length = 0;
  for (let i = 0; i < n; i++) {
    const t = new Note("n" + i);
    h = mix(h, codeOf(t.text));
  }
  for (const p of kept) h = mix(mix(h, codeOf(p.name)), p.age);
  return h;
}

/** Arrays of arrays of strings, dropped one after another, while new strings are made between. */
export function nested(n: number): number {
  let h = 0;
  for (let r = 0; r < 4; r++) {
    const rows: string[][] = [];
    for (let i = 0; i < n; i++) {
      const row: string[] = [];
      for (let j = 0; j < 5; j++) row.push(j === 0 ? "x" + i : "y" + (i + j));
      rows.push(row);
    }
    h = mix(h, rows.length);
    const last = rows[rows.length - 1]!;
    for (const s of last) h = mix(h, codeOf(s));
  }
  return h;
}
