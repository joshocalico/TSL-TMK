// The JS glue for down-lowered code (SPEC 4.5, export glue): it copies values into linear memory on
// entry and back out on return, so an export looks exactly like the JS function it came from. A trap
// from a lowered `throw` becomes the Error the source would have thrown. Output is one file.
import type { DownMeta } from "../host/down.ts";

const RUNTIME = String.raw`
const ARRAY = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array, f64: Float64Array };
const stringOf = new Map(Object.entries(meta.strings).map(([s, n]) => [n, s]));
const ERRORS = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };

export async function instantiate(bytes) {
  let jsModule = null;
  if (meta.fallbackFile !== null) jsModule = await import(new URL("./" + meta.fallbackFile, import.meta.url).href);
  let ex = null;
  const toThrow = (code) => {
    const site = meta.traps[String(code)];
    if (site === undefined) return new TslTrap(code);
    const { ctor, parts } = JSON.parse(site);
    const argBase = ex.__trap_args_addr();
    const view = new DataView(ex.memory.buffer);
    let msg = "";
    for (const p of parts) {
      if (typeof p === "string") { msg += p; continue; }
      const at = argBase + p.a * 8;
      if (p.k === "f64") msg += String(view.getFloat64(at, true));
      else if (p.k === "u32") msg += String(view.getUint32(at, true));
      else if (p.k === "bool") msg += String(view.getInt32(at, true) !== 0);
      else if (p.k === "str") msg += String(stringOf.get(view.getInt32(at, true)));
      else msg += String(view.getInt32(at, true));
    }
    return new (ERRORS[ctor] ?? Error)(msg);
  };

  const stackTop = { value: 0 };
  // One call's bookkeeping: arrays sharing a buffer share a region, so aliasing survives the copy.
  const newCall = () => ({ regions: new Map(), objects: new Map(), jsOf: new Map(), writes: [] });
  const collect = (d, v, call, seen) => {
    if (v === null || v === undefined) return;
    if (d.k === "opt") return collect(d.of, v, call, seen);
    if (d.k === "arr") {
      let r = call.regions.get(v.buffer);
      if (r === undefined) { r = { from: v.byteOffset, to: v.byteOffset + v.byteLength, at: 0, align: 8 }; call.regions.set(v.buffer, r); }
      r.from = Math.min(r.from, v.byteOffset);
      r.to = Math.max(r.to, v.byteOffset + v.byteLength);
      return;
    }
    if (d.k === "ref") {
      if (seen.has(v)) return;
      seen.add(v);
      const h = meta.heap[d.id];
      if (h.k === "vec") { for (let i = 0; i < v.length; i++) collect(h.elem, v[i], call, seen); return; }
      for (const f of h.fields) collect(f.ty, v[f.name], call, seen);
    }
  };
  const placeRegions = (call) => {
    for (const [buffer, r] of call.regions) {
      const start = r.from - (r.from % 8);
      r.base = start;
      const size = r.to - start;
      const at = ex.__alloc(size);
      r.at = at;
      new Uint8Array(ex.memory.buffer, at, size).set(new Uint8Array(buffer, start, size));
    }
  };
  const addrOf = (a, call) => {
    const r = call.regions.get(a.buffer);
    return r.at + (a.byteOffset - r.base);
  };

  const writeLeaf = (view, at, d, v, call) => {
    switch (d.k) {
      case "num":
        if (d.rep === "f64") view.setFloat64(at, v, true); else view.setInt32(at, v | 0, true);
        return;
      case "bool": view.setUint8(at, v ? 1 : 0); return; // a byte, by TSL's layout (R6, D36)
      case "str": view.setInt32(at, toStr(v), true); return;
      case "opt":
        if (v === null || v === undefined) { view.setUint8(at, 0); return; }
        view.setUint8(at, 1);
        writeLeaf(view, at + d.off, d.of, v, call);
        return;
      case "arr":
        if (v === null || v === undefined) { view.setUint32(at, 0, true); view.setUint32(at + 8, 0, true); return; }
        { const p = addrOf(v, call); const w = new DataView(ex.memory.buffer); w.setUint32(at, p, true); w.setUint32(at + 8, v.length, true); }
        return;
      case "ref":
        { const p = (v === null || v === undefined) ? 0 : toHeap(d, v, call); new DataView(ex.memory.buffer).setUint32(at, p, true); }
        return;
    }
  };
  const toStr = (v) => {
    const n = meta.strings[v];
    if (n === undefined) throw new TypeError("a string this program doesn't know: " + v);
    return n;
  };
  const toHeap = (d, v, call) => {
    const seen = call.objects.get(v);
    if (seen !== undefined) return seen;
    const h = meta.heap[d.id];
    if (h.k === "vec") {
      const hdr = ex.__vec_new(v.length, h.slot);
      call.objects.set(v, hdr);
      call.jsOf.set(hdr, v);
      const data = new DataView(ex.memory.buffer).getUint32(hdr, true);
      for (let i = 0; i < v.length; i++) writeLeaf(new DataView(ex.memory.buffer), data + i * h.slot, h.elem, v[i], call);
      if (h.written) call.writes.push([h, v, hdr]);
      return hdr;
    }
    const at = ex.__alloc(Math.max(8, h.size)); // TSL's size can be under 8 since R6, as the module allocates
    new Uint8Array(ex.memory.buffer, at, h.size).fill(0);
    call.objects.set(v, at);
    call.jsOf.set(at, v);
    for (const f of h.fields) writeLeaf(new DataView(ex.memory.buffer), at + f.off, f.ty, v[f.name], call);
    if (h.written) call.writes.push([h, v, at]);
    return at;
  };
  const toLeaves = (d, v, out, call) => {
    switch (d.k) {
      case "num": out.push(d.rep === "f64" ? v : (v | 0)); return;
      case "bool": out.push(v ? 1 : 0); return;
      case "str": out.push(toStr(v)); return;
      case "opt":
        if (v === null || v === undefined) { out.push(0); toLeaves(d.of, zeroOf(d.of), out, call); return; }
        out.push(1);
        toLeaves(d.of, v, out, call);
        return;
      case "arr":
        if (v === null || v === undefined) { out.push(0, 0); return; }
        out.push(addrOf(v, call), v.length);
        return;
      case "ref":
        out.push(v === null || v === undefined ? 0 : toHeap(d, v, call));
        return;
      default: return;
    }
  };
  const zeroOf = (d) => (d.k === "bool" ? false : d.k === "str" ? Object.keys(meta.strings)[0] : 0);

  const nullish = (nul) => (nul === "null" ? null : undefined);
  const readLeaf = (view, at, d, call) => {
    switch (d.k) {
      case "num":
        if (d.rep === "f64") return view.getFloat64(at, true);
        return d.rep === "u32" ? view.getUint32(at, true) : view.getInt32(at, true);
      case "bool": return view.getUint8(at) !== 0;
      case "str": return stringOf.get(view.getInt32(at, true));
      case "opt":
        return view.getUint8(at) === 0 ? nullish(d.nul) : readLeaf(view, at + d.off, d.of, call);
      case "arr": {
        const p = view.getUint32(at, true);
        if (p === 0) return nullish(d.nul);
        return arrayOut(d, p, view.getUint32(at + 8, true), call);
      }
      case "ref": {
        const p = view.getUint32(at, true);
        return p === 0 ? nullish(d.nul) : fromHeap(d, p, call);
      }
      default: return undefined;
    }
  };
  const arrayOut = (d, p, len, call) => {
    const Arr = ARRAY[d.elem];
    // A view into an array that came from JS stays a view of it, as it would on V8.
    for (const [buffer, r] of call.regions) {
      const size = r.to - r.base;
      if (p >= r.at && p + len * Arr.BYTES_PER_ELEMENT <= r.at + size) return new Arr(buffer, r.base + (p - r.at), len);
    }
    const key = p + ":" + len + ":" + d.elem;
    const hit = call.jsOf.get(key);
    if (hit !== undefined) return hit;
    const bytes = new Uint8Array(ex.memory.buffer, p, len * Arr.BYTES_PER_ELEMENT).slice();
    const out = new Arr(bytes.buffer, 0, len);
    call.jsOf.set(key, out);
    return out;
  };
  const fromHeap = (d, p, call) => {
    const hit = call.jsOf.get(p);
    if (hit !== undefined) return hit;
    const h = meta.heap[d.id];
    if (h.k === "vec") {
      const out = [];
      call.jsOf.set(p, out);
      fillVec(h, out, p, call);
      return out;
    }
    const out = {};
    call.jsOf.set(p, out);
    fillObj(h, out, p, call);
    return out;
  };
  const fillObj = (h, out, p, call) => {
    const view = new DataView(ex.memory.buffer);
    const fields = variantFields(h, view, p, call);
    for (const f of h.fields) {
      if (fields !== null && !fields.includes(f.name)) continue;
      const v = readLeaf(view, p + f.off, f.ty, call);
      if (v === undefined && f.optional) { delete out[f.name]; continue; }
      out[f.name] = v;
    }
  };
  const variantFields = (h, view, p, call) => {
    if (h.variants.length === 0) return null;
    const tagName = h.variants[0].tag;
    const tag = h.fields.find((f) => f.name === tagName);
    if (tag === undefined) return null;
    const value = readLeaf(view, p + tag.off, tag.ty, call);
    return h.variants.find((v) => v.value === value)?.fields ?? null;
  };
  const fillVec = (h, out, p, call) => {
    const view = new DataView(ex.memory.buffer);
    const data = view.getUint32(p, true);
    const len = view.getUint32(p + 8, true);
    out.length = len;
    for (let i = 0; i < len; i++) {
      const at = data + i * h.slot;
      if (h.holes && view.getUint32(at, true) === 0 && h.elem.nul === undefined) { delete out[i]; continue; }
      out[i] = readLeaf(view, at, h.elem, call);
    }
  };
  const fromLeaves = (d, r, at, call) => {
    switch (d.k) {
      case "num": return [d.rep === "u32" ? r[at] >>> 0 : r[at], at + 1];
      case "bool": return [r[at] !== 0, at + 1];
      case "str": return [stringOf.get(r[at]), at + 1];
      case "opt": {
        const [v, next] = fromLeaves(d.of, r, at + 1, call);
        return [r[at] === 0 ? nullish(d.nul) : v, next];
      }
      case "arr":
        if (r[at] === 0) return [nullish(d.nul), at + 2];
        return [arrayOut(d, r[at] >>> 0, r[at + 1] >>> 0, call), at + 2];
      case "ref":
        return [r[at] === 0 ? nullish(d.nul) : fromHeap(d, r[at] >>> 0, call), at + 1];
      default: return [undefined, at];
    }
  };

  // A call from lowered code into a function that stayed JS: copies out, calls, copies back.
  const shim = (s) => (...leaves) => {
    let at = 0;
    const args = [];
    const backs = [];
    for (const d of s.params) {
      const call = newCall();
      const [v, next] = fromLeaves(d, leaves, at, call);
      if (d.k === "arr" && v !== null && v !== undefined) {
        const p = leaves[at] >>> 0;
        const copy = v;
        backs.push(() => new Uint8Array(ex.memory.buffer, p, copy.byteLength).set(new Uint8Array(copy.buffer, copy.byteOffset, copy.byteLength)));
      }
      args.push(v);
      at = next;
    }
    const r = jsModule[s.js](...args);
    for (const b of backs) b();
    if (s.ret.k === "void") return undefined;
    const call = newCall();
    if (s.ret.k === "arr") {
      collect(s.ret, r, call, new Set());
      placeRegions(call);
    }
    const out = [];
    toLeaves(s.ret, r, out, call);
    return out.length === 1 ? out[0] : out;
  };
  const jsImports = {};
  for (const [name, s] of Object.entries(meta.shims)) jsImports[name] = shim(s);

  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { __tsl_trap(code) { throw toThrow(code); } },
    math: Math,
    js: jsImports,
  });
  ex = instance.exports;
  if (ex.__sp !== undefined) stackTop.value = ex.__sp.value;
  ex.__init();

  const out = {};
  for (const [name, sig] of Object.entries(meta.exports)) {
    if (sig.fallback === true) {
      out[name] = jsModule[name];
      continue;
    }
    out[name] = (...args) => {
      ex.__arena_reset();
      if (ex.__sp !== undefined) ex.__sp.value = stackTop.value;
      const call = newCall();
      const seen = new Set();
      sig.params.forEach((d, i) => collect(d, args[i], call, seen));
      placeRegions(call);
      const leaves = [];
      sig.params.forEach((d, i) => toLeaves(d, args[i], leaves, call));
      const writtenArrays = sig.params.some((d) => hasWrittenArray(d));
      try {
        const r = ex[name](...leaves);
        const flat = Array.isArray(r) ? r : [r];
        return sig.ret.k === "void" ? undefined : fromLeaves(sig.ret, flat, 0, call)[0];
      } finally {
        if (writtenArrays) {
          for (const [buffer, region] of call.regions) {
            const size = region.to - region.base;
            new Uint8Array(buffer, region.base, size).set(new Uint8Array(ex.memory.buffer, region.at, size));
          }
        }
        for (const [h, v, p] of call.writes) {
          if (h.k === "vec") fillVec(h, v, p, call);
          else fillObj(h, v, p, call);
        }
      }
    };
  }
  return out;
}

function hasWrittenArray(d, seen = new Set()) {
  if (d.k === "arr") return d.written === true;
  if (d.k === "opt") return hasWrittenArray(d.of, seen);
  if (d.k === "ref") {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    const h = meta.heap[d.id];
    if (h.k === "vec") return hasWrittenArray(h.elem, seen);
    return h.fields.some((f) => hasWrittenArray(f.ty, seen));
  }
  return false;
}
`;

export function emitDownGlue(meta: DownMeta): string {
  return `// Generated by tslc. Do not edit.
const TSL_CORE = await import("@tsl/core").catch(() => null);
const TslTrap = TSL_CORE?.TslTrap ?? class TslTrap extends Error { constructor(code) { super("trap " + code); this.code = code; } };
export { TslTrap };
const meta = ${JSON.stringify(meta)};
${RUNTIME}`;
}
