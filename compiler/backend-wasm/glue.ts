// The JS glue for a compiled module: it exposes each export as a function, flattens value types,
// and copies typed arrays into linear memory (SPEC M1, step 7). The output is one standalone file.
import type { Desc } from "../host/types.ts";

export interface ExportMeta {
  params: Desc[];
  ret: Desc;
}

export interface ModuleMeta {
  exports: Record<string, ExportMeta>;
  strings: Record<string, number>;
}

const RUNTIME = `
const ARRAY = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array, u64: BigUint64Array, i64: BigInt64Array };
const RANGE = { u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767], u32: [0, 4294967295], i32: [-2147483648, 2147483647], usize: [0, 9007199254740991] };
const stringOf = new Map(Object.entries(meta.strings).map(([s, n]) => [n, s]));

function toLeaves(d, v, out, ctx) {
  switch (d.k) {
    case "scalar": return scalarIn(d.name, v, out);
    case "enum": case "nums": out.push(v | 0); return;
    case "strs": { const n = meta.strings[v]; if (n === undefined) throw new TypeError("unknown literal " + v); out.push(n); return; }
    case "arr": { const at = ctx.place(v); out.push(at, v.length); return; }
    case "rec": for (const f of d.fields) toLeaves(f.ty, v[f.name], out, ctx); return;
    case "union": {
      const variant = d.variants.find((x) => x.tag === v[d.tag]);
      if (variant === undefined) throw new TypeError("unknown tag " + v[d.tag]);
      const slots = new Array(d.nslots).fill(null);
      for (const f of variant.fields) {
        const leaves = [];
        toLeaves(f.ty, v[f.name], leaves, ctx);
        f.slots.forEach((s, i) => { slots[s] = leaves[i]; });
      }
      out.push(variant.leaf);
      for (let i = 0; i < d.nslots; i++) out.push(slots[i] ?? ctx.zero(d, i));
      return;
    }
    case "fn": throw new TypeError("a function reference can't cross from JS in M1");
    default: throw new TypeError("no value of this type crosses from JS");
  }
}

function scalarIn(name, v, out) {
  if (name === "bool") { out.push(v ? 1 : 0); return; }
  if (name === "u64" || name === "i64") { out.push(BigInt(v)); return; }
  if (name === "f64") { out.push(v); return; }
  if (name === "f32") {
    if (Math.fround(v) !== v && !Number.isNaN(v)) throw new TypeError("f32 argument isn't exact in f32: " + v);
    out.push(v);
    return;
  }
  const r = RANGE[name];
  if (!Number.isInteger(v) || v < r[0] || v > r[1]) throw new TypeError(name + " argument out of range: " + v);
  if (name === "usize" && v > 4294967295) throw new TslTrap(4); // allowed divergence 3, on wasm32
  out.push(v | 0);
}

function fromLeaves(d, leaves, at) {
  switch (d.k) {
    case "scalar": return [scalarOut(d.name, leaves[at]), at + 1];
    case "enum": case "nums": return [leaves[at], at + 1];
    case "strs": return [stringOf.get(leaves[at]), at + 1];
    case "rec": {
      const o = {};
      let p = at;
      for (const f of d.fields) { const [v, next] = fromLeaves(f.ty, leaves, p); o[f.name] = v; p = next; }
      return [o, p];
    }
    case "union": {
      const variant = d.variants.find((x) => x.leaf === leaves[at]);
      const o = { [d.tag]: variant.tag };
      for (const f of variant.fields) {
        const sub = f.slots.map((s) => leaves[at + 1 + s]);
        o[f.name] = fromLeaves(f.ty, sub, 0)[0];
      }
      return [o, at + 1 + d.nslots];
    }
    default: return [undefined, at];
  }
}

function scalarOut(name, v) {
  switch (name) {
    case "bool": return v !== 0;
    case "u64": return BigInt.asUintN(64, v);
    case "u32": case "usize": return v >>> 0;
    default: return v;
  }
}

export async function instantiate(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { __tsl_trap(code) { throw new TslTrap(code); } },
  });
  const ex = instance.exports;
  const heapBase = ex.__heap_base.value;
  const out = {};
  for (const [name, sig] of Object.entries(meta.exports)) {
    out[name] = (...args) => {
      // Bump arena per export call: the arrays live here for just this call.
      let top = heapBase;
      const copies = [];
      const placed = new Map();
      const ctx = {
        place(a) {
          const seen = placed.get(a);
          if (seen !== undefined) return seen;
          const align = Math.max(a.BYTES_PER_ELEMENT, 8);
          const at = Math.ceil(top / align) * align;
          top = at + a.byteLength;
          const need = Math.ceil(top / 65536) - ex.memory.buffer.byteLength / 65536;
          if (need > 0) ex.memory.grow(need);
          new Uint8Array(ex.memory.buffer, at, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
          copies.push([a, at]);
          placed.set(a, at);
          return at;
        },
        zero(d, i) { return d.slotTypes[i] === "i64" ? 0n : 0; },
      };
      const leaves = [];
      sig.params.forEach((d, i) => toLeaves(d, args[i], leaves, ctx));
      try {
        const r = ex[name](...leaves);
        if (sig.ret.k === "void") return undefined;
        const flat = Array.isArray(r) ? r : [r];
        return fromLeaves(sig.ret, flat, 0)[0];
      } finally {
        for (const [a, at] of copies) {
          new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(new Uint8Array(ex.memory.buffer, at, a.byteLength));
        }
      }
    };
  }
  return out;
}
`;

export function emitGlue(meta: ModuleMeta): string {
  return `// Generated by tslc. Do not edit.
import { TslTrap } from "@tsl/core";
const meta = ${JSON.stringify(meta)};
${RUNTIME}`;
}
