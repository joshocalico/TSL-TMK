// R33: freeing in `rc` with the collector linked (Tag can be in a cycle), where freeing frees one object an allocation
// and its cursor works through a large array's slots two steps at a time: an array of strings let go of at once, then
// strings made one at a time. No release function can reach `stepping`; strings' release functions reach `spare`. Rings of
// tags holding labels are let go of too, which the collector frees with their strings. What's kept is read after.
class Tag {
  next: Tag | null = null;
  constructor(public label: string) {}
}

class Box {
  constructor(public v: number) {}
}

function mix(h: number, x: number): number {
  return Math.imul(h ^ x, 16777619) >>> 0;
}

function codeOf(s: string): number {
  let c = s.length;
  for (let i = 0; i < s.length; i++) c = mix(c, s.charCodeAt(i));
  return c;
}

let many: string[] = [];

/** An array of strings kept in module state, let go of at once by the next call, then strings made one at a time. */
export function keepMany(n: number): number {
  many = [];
  for (let i = 0; i < n; i++) many.push("s" + i);
  let h = 0;
  for (let i = 0; i < n; i++) h = mix(h, codeOf("k" + i * 3));
  return mix(h, many.length);
}

/** Rings of tags, each holding its label, let go of; boxes made between; one ring's labels read before it goes. */
export function rings(n: number): number {
  let h = 0;
  for (let r = 0; r < 3; r++) {
    const first = new Tag("r" + r);
    let t = first;
    for (let i = 1; i < n; i++) {
      const u = new Tag(i % 2 === 0 ? "a" + i : "b" + (i + r));
      t.next = u;
      t = u;
    }
    t.next = first;
    for (let i = 0; i < n; i++) h = mix(h, new Box(i).v);
    let p: Tag | null = first;
    for (let i = 0; i < n && p !== null; i++) {
      h = mix(h, codeOf(p.label));
      p = p.next;
    }
  }
  return h;
}

/** keepMany twice over, so the second call's freeing meets the first's array, then a view of a kept string read. */
export function twice(n: number): number {
  const a = keepMany(n);
  const b = keepMany(n + 3);
  const s = many[n - 1]!;
  return mix(mix(a, b), codeOf(s.slice(1)));
}
