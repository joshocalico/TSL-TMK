// Iteration across the incremental move (SPEC 3.5, D47): every form of iterator, over tables at and around the sizes where a
// move starts, with changes at chosen positions that start a move, run into one, or sleep through several. JS defines every
// result exactly, and V8 is the reference. A digest of what was visited comes back.
function mix(h: number, x: number): number {
  return Math.imul((h ^ x) >>> 0, 16777619) >>> 0;
}

/** n entries, keys 0..n-1 with values 1000+i, and every third deleted if `holes`, so a move has tombstones to skip. */
function build(n: number, holes: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(i, 1000 + i);
  if (holes !== 0) for (let i = 0; i < n; i += 3) m.delete(i);
  return m;
}

function change(m: Map<number, number>, op: number, a: number, cur: number, tick: number): void {
  switch (op) {
    case 1:
      // Enough new keys to start a move, or to run one on.
      for (let i = 0; i < a; i++) m.set(10000 + tick * 1000 + i, i);
      break;
    case 2:
      for (let i = 0; i < a; i++) m.set(20000 + tick * 1000 + i, i);
      for (let i = 0; i < a; i += 2) m.delete(i);
      break;
    case 3:
      m.delete(cur);
      m.set(cur, 3000 + tick);
      break;
    case 4:
      m.clear();
      for (let i = 0; i < a; i++) m.set(40000 + i, i);
      break;
    case 5:
      // Several moves while the cursor waits.
      for (let i = 0; i < a * 10; i++) m.set(50000 + tick * 10000 + i, i);
      break;
    case 6:
      for (let i = 0; i < 200; i++) m.delete(i);
      for (let i = 0; i < a; i++) m.set(60000 + i, i);
      break;
    case 7:
      // Deletes ahead of the cursor, among what a move hasn't reached.
      for (let i = cur + 1; i < cur + 1 + a; i++) m.delete(i);
      m.set(70000 + tick, tick);
      break;
    default:
      break;
  }
}

/** One form of iteration over a table of n, with `op` done when it reaches position `at`. */
export function visit(
  form: number,
  n: number,
  holes: number,
  op: number,
  a: number,
  at: number,
): number {
  const m = build(n, holes);
  let h = 0x811c9dc5;
  let tick = 0;
  if (form === 0) {
    for (const [k, v] of m) {
      h = mix(mix(h, k), v);
      if (tick === at) change(m, op, a, k, tick);
      tick++;
      if (tick > 100000) break;
    }
  } else if (form === 1) {
    m.forEach((v, k) => {
      h = mix(mix(h, k), v);
      if (tick === at) change(m, op, a, k, tick);
      tick++;
    });
  } else if (form === 2) {
    const it = m.keys();
    for (let r = it.next(); !r.done; r = it.next()) {
      const k = r.value;
      h = mix(h, k);
      if (tick === at) change(m, op, a, k, tick);
      tick++;
      if (tick > 100000) break;
    }
  } else if (form === 3) {
    for (const v of m.values()) {
      h = mix(h, v);
      if (tick === at) change(m, op, a, v - 1000, tick);
      tick++;
      if (tick > 100000) break;
    }
  } else {
    const it = m.entries();
    for (let r = it.next(); !r.done; r = it.next()) {
      const [k, v] = r.value;
      h = mix(mix(h, k), v);
      if (tick === at) change(m, op, a, k, tick);
      tick++;
      if (tick > 100000) break;
    }
  }
  h = mix(h, m.size);
  for (const [k, v] of m) h = mix(mix(h, k), v);
  return h;
}

/** An iterator made, moved on `first` times, left while `inserts` keys go in (moves start and finish), then finished. */
export function sleeper(n: number, first: number, inserts: number, deletes: number): number {
  const m = build(n, 0);
  const it = m.entries();
  let h = 0x811c9dc5;
  for (let i = 0; i < first; i++) {
    const r = it.next();
    if (r.done) break;
    h = mix(mix(h, r.value[0]), r.value[1]);
  }
  for (let i = 0; i < inserts; i++) {
    m.set(100000 + i, i);
    if (i < deletes) m.delete(i * 2);
  }
  for (let r = it.next(); !r.done; r = it.next()) h = mix(mix(h, r.value[0]), r.value[1]);
  // Finished stays finished, whatever comes after.
  m.set(999999, 1);
  h = mix(h, it.next().done ? 1 : 0);
  return mix(h, m.size);
}

/** An iterator made while a move is on, stepped between the inserts that carry the move. */
export function midMove(n: number, before: number, steps: number): number {
  const m = build(n, 0);
  // Fill to the table's size, then one more: the move starts there.
  for (let i = 0; i < before; i++) m.set(200000 + i, i);
  const it = m.keys();
  let h = 0x811c9dc5;
  for (let s = 0; s < steps; s++) {
    const r = it.next();
    if (r.done) {
      h = mix(h, 7);
      break;
    }
    h = mix(h, r.value);
    m.set(300000 + s, s);
    if (s % 3 === 0) m.delete(s);
    if (s % 5 === 0) m.set(s + 1, -s);
  }
  for (let r = it.next(); !r.done; r = it.next()) h = mix(h, r.value);
  return mix(h, m.size);
}

/** Sets: the same through a move. */
export function setVisit(n: number, op: number, at: number): number {
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(i);
  let h = 0x811c9dc5;
  let tick = 0;
  for (const k of s) {
    h = mix(h, k);
    if (tick === at) {
      if (op === 1) for (let i = 0; i < n + 3; i++) s.add(5000 + i);
      else if (op === 2) for (let i = 0; i < n; i += 2) s.delete(i);
      else if (op === 3) {
        s.clear();
        for (let i = 0; i < 9; i++) s.add(7000 + i);
      } else if (op === 4) {
        for (let i = 0; i < n * 3; i++) s.add(8000 + i);
        for (let i = 0; i < n; i++) s.delete(i);
      }
    }
    tick++;
    if (tick > 100000) break;
  }
  h = mix(h, s.size);
  for (const k of s) h = mix(h, k);
  return h;
}
