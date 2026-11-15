// R12: objects in a `strict` lowered program (pile item 7), measured through both routes (`tmk bench memory --classes
// --strict`). What escapes its function goes in the call arena, which the caller resets between calls (D36); what doesn't
// stays on the stack. Nothing else of phase 2 is in it: no arrays, strings, maps or closures, which `strict` doesn't print.
class Vec3 {
  x = 0;
  y = 0;
  z = 0;
  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  add(o: Vec3): Vec3 {
    return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z);
  }
  scale(k: number): Vec3 {
    return new Vec3(this.x * k, this.y * k, this.z * k);
  }
  dot(o: Vec3): number {
    return this.x * o.x + this.y * o.y + this.z * o.z;
  }
}

class Body {
  pos: Vec3;
  vel: Vec3;
  hits = 0;
  constructor(pos: Vec3, vel: Vec3) {
    this.pos = pos;
    this.vel = vel;
  }
  step(dt: number): void {
    this.pos = this.pos.add(this.vel.scale(dt));
    if (this.pos.x > 1000) {
      this.pos = new Vec3(0, this.pos.y, this.pos.z);
      this.hits++;
    }
  }
}

function spawn(i: number): Body {
  return new Body(new Vec3(i, 0, 1), new Vec3(1 + (i & 3), 0.5, 0));
}

/** Short-lived objects made by methods and kept a step: each in the call arena. */
export function vecWork(n: number): number {
  let acc = new Vec3(0, 0, 0);
  for (let i = 0; i < (n | 0); i++) {
    const v = new Vec3(i, i + 1, i + 2);
    acc = acc.add(v.scale(0.5));
  }
  return (acc.x + acc.y + acc.z) | 0;
}

/** Objects that never leave their function: on the stack, through both routes. */
export function localWork(n: number): number {
  let t = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = new Vec3(i, 1, 2);
    const b = new Vec3(2, i & 7, 1);
    t = (t + a.dot(b)) | 0;
  }
  return t;
}

/** A few objects holding others, stepped many times: field reads and writes through references. */
export function bodyWork(n: number): number {
  const a = spawn(1);
  const b = spawn(2);
  for (let i = 0; i < (n | 0); i++) {
    a.step(1);
    b.step(0.5);
  }
  return (a.pos.x + b.pos.x + a.hits * 1000 + b.hits * 1000) | 0;
}
