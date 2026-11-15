// A graph: adjacency by Map and Vec, breadth-first search with a Set, topological order, and shortest paths (SPEC 3.5).
import { toU32, u32, type bool, type usize } from "@tsl/core";
import { ExactMap, ref, Set, Slab, Vec } from "@tsl/std";

class Vertex {
  out = new Vec(u32);
  weights = new Vec(u32);
  constructor(public id: u32) {}
}

class Graph {
  private all = new Slab<Vertex>();
  private byId = new ExactMap(u32, ref<Vertex>());

  vertex(id: u32): Vertex {
    if (this.byId.has(id)) return this.byId.get(id);
    const v = this.all.add(new Vertex(id));
    this.byId.set(id, v);
    return v;
  }

  edge(from: u32, to: u32, w: u32): void {
    const v = this.vertex(from);
    v.out.push(to);
    v.weights.push(w);
    this.vertex(to);
  }

  has(id: u32): bool {
    return this.byId.has(id);
  }

  /** How many are reachable from a start, by a queue that's a Vec with an index. */
  reachable(start: u32): u32 {
    using seen = new Set(u32);
    using queue = new Vec(u32);
    seen.add(start);
    queue.push(start);
    for (let head: usize = 0; head < queue.length; head++) {
      const v = this.byId.get(queue.get(head));
      v.out.forEach((to) => {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      });
    }
    return toU32(seen.size);
  }

  /** Kahn's algorithm: a digest of the order, or 0xffffffff if there's a cycle. */
  topo(): u32 {
    using degree = new ExactMap(u32, u32);
    this.byId.forEach((id) => {
      degree.set(id, 0);
    });
    this.byId.forEach((_id, v) => {
      v.out.forEach((to) => {
        degree.set(to, degree.get(to) + 1);
      });
    });
    using ready = new Vec(u32);
    this.byId.forEach((id) => {
      if (degree.get(id) === 0) ready.push(id);
    });
    let done: u32 = 0;
    let digest: u32 = 0;
    while (ready.length > 0) {
      const id: u32 = ready.pop();
      done++;
      digest = ((Math.imul(digest, 33) >>> 0) + id) >>> 0;
      const v = this.byId.get(id);
      for (let i: usize = 0; i < v.out.length; i++) {
        const to = v.out.get(i);
        const d = degree.get(to) - 1;
        degree.set(to, d);
        if (d === 0) ready.push(to);
      }
    }
    return done === toU32(this.byId.size) ? digest : 0xffffffff;
  }

  /** Dijkstra with a plain scan for the nearest: the distance to one vertex, or 0xffffffff. */
  distance(from: u32, to: u32): u32 {
    using dist = new ExactMap(u32, u32);
    using done = new Set(u32);
    dist.set(from, 0);
    for (;;) {
      let best: u32 = 0xffffffff;
      let at: u32 = 0;
      dist.forEach((id, d) => {
        if (!done.has(id) && d < best) {
          best = d;
          at = id;
        }
      });
      if (best === 0xffffffff) return 0xffffffff;
      if (at === to) return best;
      done.add(at);
      const v = this.byId.get(at);
      for (let i: usize = 0; i < v.out.length; i++) {
        const next = v.out.get(i);
        const d = best + v.weights.get(i);
        if (d < dist.getOr(next, 0xffffffff)) dist.set(next, d);
      }
    }
  }

  free(): void {
    this.all.forEach((v) => {
      v.out.free();
      v.weights.free();
    });
    this.byId.free();
  }
}

function grid(g: Graph, n: u32): void {
  for (let i: u32 = 0; i < n; i++) {
    for (let j: u32 = 0; j < n; j++) {
      const at = i * n + j;
      if (j + 1 < n) g.edge(at, at + 1, (at % 7) + 1);
      if (i + 1 < n) g.edge(at, at + n, (at % 5) + 1);
    }
  }
}

export function gridReach(n: u32): u32 {
  const g = new Graph();
  grid(g, n);
  const r = g.reachable(0);
  g.free();
  return r;
}

export function gridTopo(n: u32): u32 {
  const g = new Graph();
  grid(g, n);
  const r = g.topo();
  g.free();
  return r;
}

export function gridDistance(n: u32): u32 {
  const g = new Graph();
  grid(g, n);
  const r = g.distance(0, n * n - 1);
  g.free();
  return r;
}

export function cycleHasNoOrder(): u32 {
  const g = new Graph();
  g.edge(1, 2, 1);
  g.edge(2, 3, 1);
  g.edge(3, 1, 1);
  const r = g.topo();
  g.free();
  return r;
}

export function unreachable(): u32 {
  const g = new Graph();
  g.edge(1, 2, 1);
  g.vertex(3);
  const r = g.distance(1, 3);
  const has = g.has(2);
  g.free();
  return has ? r : 0;
}
