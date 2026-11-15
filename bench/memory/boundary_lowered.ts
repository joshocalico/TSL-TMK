// R5's boundary benchmark (SPEC 4.5's native ABI, D36): exported functions that take and give objects and arrays, called
// in a hot loop, so the TSL route's classes laid out at D36's offsets (TSL's own layout since R6) are measured
// against the direct route's own layout. Each export also crosses to a native caller; here they're called from inside.
type Vec3 = { x: number; y: number; z: number; live: boolean; hits: number };
type Body = { pos: Vec3; vel: Vec3; mass: number; asleep: boolean; bounced: boolean };

export function makeBodies(n: number): Body[] {
  const out: Body[] = [];
  for (let i = 0; i < (n | 0); i++) {
    out.push({
      pos: { x: i, y: i * 0.5, z: 0, live: true, hits: 0 },
      vel: { x: 1, y: -0.25 * (i & 3), z: 0.125, live: (i & 1) === 0, hits: 0 },
      mass: 1 + (i & 7),
      asleep: false,
      bounced: false,
    });
  }
  return out;
}

export function step(b: Body, dt: number): Body {
  if (b.asleep) return b;
  const p = b.pos;
  const v = b.vel;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;
  if (p.y < 0) {
    p.y = -p.y;
    v.y = -v.y;
    v.hits = (v.hits + 1) | 0;
    b.bounced = true;
  }
  if (v.live && v.hits > 64) b.asleep = true;
  return b;
}

export function energy(bs: Body[]): number {
  let e = 0;
  for (const b of bs) {
    const v = b.vel;
    if (!b.asleep) e += 0.5 * b.mass * (v.x * v.x + v.y * v.y + v.z * v.z);
    if (b.bounced) e += 0.001;
  }
  return e;
}

export function boundaryWork(n: number): number {
  const bs = makeBodies(64);
  let e = 0;
  for (let i = 0; i < (n | 0); i++) {
    const b = step(bs[i & 63]!, 0.01);
    if (b.bounced) e += 0.0001;
    if ((i & 4095) === 0) e += energy(bs);
  }
  for (let r = 0; r < 64; r++) e += energy(bs);
  return (e * 1000) | 0;
}
