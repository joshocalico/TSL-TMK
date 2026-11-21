// memory-pages: 48
// R34 (SPEC 3.5, D39's R34): freeing in `rc` through the TSL route where most of what waits is a leaf. A flat string's one
// reference (`buf`) is null and only its constructor writes it, so the runtime's `jsStrZeroed` makes it in its store's
// leaf entry and freeing gives it back as one step with no call, a run of them at once; a view's buffer, and an array's
// room, are handed back to freeing through what their holder's release function returns, where `spare` gave them back.
// Long strings built by appending (views over buffers that grow) are made and let go of many times over in a small
// memory, so a view freed without its buffer, or a buffer or room lost, runs memory out where JS doesn't; arrays of
// strings outgrow their holders into rooms and are let go of; and what's kept past each is read again, so a block given
// back twice or a step skipped shows.
function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

/** Strings of up to 300 units built by appending (views over growing buffers), each read and let go of, n times. */
export function appends(n: number): number {
  let h = 0;
  for (let r = 0; r < n; r++) {
    let s = "";
    const k = 40 + (r % 260);
    while (s.length < k) s += "abcdefgh".slice(r % 4, 4 + (r % 5));
    h = mix(h, codeOf(s));
    if (r % 50 === 0) h = mix(h, s.length);
  }
  return h;
}

/** Short strings made a unit at a time and let go of (flat strings, freed in runs), some kept and read after. */
export function units(n: number): number {
  const kept: string[] = [];
  let h = 0;
  for (let r = 0; r < n; r++) {
    let c = "";
    for (let j = 0; j < 12; j++) c += String.fromCharCode(97 + ((r + j) % 26));
    h = mix(h, codeOf(c));
    if (r % 37 === 0) kept.push(c);
  }
  for (const k of kept) h = mix(h, codeOf(k));
  return h;
}

/** Arrays of strings past their holder's room, let go of whole, while new strings are made between; one kept. */
export function rooms(n: number): number {
  let h = 0;
  let keep: string[] = [];
  for (let r = 0; r < n; r++) {
    const row: string[] = [];
    for (let j = 0; j < 20 + (r % 13); j++) row.push(j % 3 === 0 ? "r" + r : "s" + j);
    h = mix(h, row.length);
    if (r % 17 === 0) keep = row;
  }
  for (const s of keep) h = mix(h, codeOf(s));
  return h;
}

/** Views and flat strings in turn, kept in an array a while, then let go of: the runs broken by views. */
export function mixed(n: number): number {
  let long = "";
  for (let i = 0; i < 200; i++) long += String.fromCharCode(97 + (i % 26));
  let h = 0;
  for (let r = 0; r < n; r++) {
    const all: string[] = [];
    for (let i = 0; i < 30; i++) all.push(i % 4 === 0 ? long.slice(i, i + 80) : "f" + (r + i));
    let t = 0;
    for (const s of all) t = mix(t, codeOf(s));
    h = mix(h, t);
  }
  return h;
}
