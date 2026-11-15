// Writes math_values.cases.json: a fixed set of inputs for the native libm, from a fixed generator.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let state = 12345;
const r = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const special = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  -2,
  3,
  10,
  100,
  1e-10,
  1e10,
  Infinity,
  -Infinity,
  NaN,
  Math.PI,
  Math.E,
  Math.PI / 2,
  Math.PI / 4,
  1e-300,
  1e300,
  5e-324,
  1.5,
  0.1,
  0.2,
  0.3,
  7,
  1e5,
  0.75,
  709.5,
  -745,
  710,
  1e-20,
];
const vals = [...special];
for (let i = 0; i < 120; i++) vals.push(r() * 2 - 1);
for (let i = 0; i < 120; i++) vals.push((r() - 0.5) * 20);
for (let i = 0; i < 80; i++) vals.push((r() - 0.5) * 2000);
for (let i = 0; i < 40; i++) vals.push((r() - 0.5) * 1e5);
for (let i = 0; i < 40; i++) vals.push(Math.exp((r() - 0.5) * 1000));
const enc = (v) =>
  Number.isNaN(v)
    ? { f64: "NaN" }
    : v === Infinity
      ? { f64: "Infinity" }
      : v === -Infinity
        ? { f64: "-Infinity" }
        : Object.is(v, -0)
          ? { f64: "-0" }
          : v;
const cases = [];
for (const v of vals) {
  for (const fn of ["sin1", "cos1", "exp1", "log1"]) {
    // Above 2^19 * pi/2, sin and cos panic by design: see compiler/backend-aarch64/libm.ts.
    if ((fn === "sin1" || fn === "cos1") && Math.abs(v) > 800000) continue;
    cases.push({ fn, args: [enc(v)] });
  }
}
for (let i = 0; i < vals.length; i++) {
  const a = vals[i];
  const b = vals[(i * 7 + 3) % vals.length];
  cases.push({ fn: "atan2v", args: [enc(a), enc(b)] });
  // V8's pow is the host's libm (SPEC 3.10, divergence 7): within one unit in the last place.
  cases.push({ fn: "powv", args: [enc(a), enc(b)], native_ulp: 1 });
  cases.push({ fn: "powv", args: [enc(Math.abs(a)), enc(b / 50)], native_ulp: 1 });
}
// Results a binary float represents exactly must be exact on every implementation.
for (const x of [0.5, 0.25, 1.5, 2, 3, -3, 4, 8, 10, -2, 1, -1, 0, 7, 1024, 0.125]) {
  for (const y of [0, 1, 2, 3, 4, -1, 0.5]) cases.push({ fn: "powv", args: [x, y] });
}
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "math_values.cases.json"), `${JSON.stringify(cases)}\n`);
