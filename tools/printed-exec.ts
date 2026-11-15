// The differential's third route (SPEC 3.10, 4.5, D71): a printed TSL package, as `tmk lower --emit tsl` wrote it, run
// unchanged on V8 (Node with tools/ts-hook.mjs) or JSC (Bun), each case's arguments placed as a native caller places them
// (D36) in @tsl/lowered's host memory, and its result, its arguments after and its trap code given in lower-exec.ts's
// canonical form, so they compare with the source on V8 and with native. No tslc code is involved in running it: what
// it reads of the build is the package's text and the meta's description of its exports.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeArg, isTypedArray } from "./canon.ts";
import {
  strictCanon,
  ERROR_NAMES,
  thrownCanon,
  thrownFromDesc,
  unescapeUnits,
  type LowerCase,
  type LowerCaseResult,
} from "./lower-exec.ts";

interface Job {
  program: string; // the printed root module
  cases: string;
  meta: string; // the build's DownMeta, as JSON
}

type Desc = {
  k: string;
  rep?: string;
  elem?: string;
  nul?: string;
  of?: Desc;
  off?: number;
  id?: number;
};
interface Field {
  name: string;
  off: number;
  ty: Desc;
  optional: boolean;
}
interface Heap {
  k: string;
  size?: number;
  slot?: number;
  elem?: Desc;
  holes?: boolean;
  tuple?: number;
  fields?: Field[];
  internal?: Field[];
  variants?: { tag: string; value: unknown; fields: string[] }[];
  map?: { kind: "map" | "set"; keyDesc: Desc; valDesc: Desc; make: string; put: string };
  place?: string; // R5: the printed export that makes one of these, a JsArray
}
interface Meta {
  exports: Record<string, { params: Desc[]; ret: Desc }>;
  heap: Record<string, Heap>;
  strings: Record<string, number>;
  exc?: { uncaught: number };
  strLayout?: unknown;
  rcStr?: unknown; // R10: `rc`'s strings are the program's own JsStr, placed by its __str_place
  // R5: what crosses an export as the printed TSL's own classes, by heap id: the class's name and each field's.
  tslClasses?: Record<
    string,
    {
      name: string;
      fields: Record<string, { name: string; value?: { name: string }; arr?: true }>;
    }
  >;
  // R7: a Map or Set crossing an export, a JsMap or JsSet, by heap id
  tslMaps?: { kinds: Record<string, "map" | "set"> };
}
/** R7: what printed TSL's JsMap and JsSet are on the host (@tsl/jsrt), as far as a caller reads one. */
type JsMapHost = {
  cursor(): unknown;
  advance(c: unknown): boolean;
  keyAt(c: unknown): unknown;
  valAt(c: unknown): unknown;
  close(c: unknown): void;
};
type Exports = Record<string, (...args: unknown[]) => unknown>;
/** R5: what printed TSL's JsArray is on the host (@tsl/jsrt), as far as a caller reads and writes it. */
type JsArrayHost = { length: number; get(i: number): unknown; set(i: number, v: unknown): void };
/**
 * R8: in `rc` an array is the program's own holder class (`JsArr_Item`), whose `v` is @tsl/gc's JsRoomArray, read and
 * written as a JsArray is; anywhere else it's the JsArray itself.
 */
function jsArr(x: unknown): JsArrayHost {
  const a = x as JsArrayHost & { v?: JsArrayHost };
  return typeof a.get === "function" ? a : a.v!;
}
type Host = {
  setStrings(t: Record<string, number>): void;
  block(size: number): number;
  read(a: number): unknown;
  write(a: number, v: unknown): void;
  readElem(ptr: number, i: number, e: string): unknown;
  writeElem(ptr: number, i: number, e: string, v: unknown): void;
  leaves(v: unknown): unknown[];
  pack(...parts: unknown[]): unknown;
  addrOf(v: unknown): number;
  isThrow(e: unknown): e is Error & { code: number; ctor: string; text: string };
};

const ARRAY: Record<
  string,
  new (n: number) => ArrayLike<number | bigint> & { [i: number]: number | bigint }
> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
  u64: BigUint64Array as never,
  i64: BigInt64Array as never,
};

class Marshal {
  placed = new Map<unknown, unknown>(); // a JS object to what it was placed as, so sharing and cycles are kept
  objects: { value: unknown; at: number; h: Heap; host?: unknown }[] = [];
  read = new Map<number, unknown>();
  hostRead = new Map<unknown, unknown>(); // R5: a printed class's instance or JsArray to what it was read as

  readonly h: Host;
  readonly meta: Meta;
  readonly ex: Exports;
  readonly jsrt: { JsFlat: { ofUnits(u: Uint16Array): unknown } };

  constructor(
    h: Host,
    meta: Meta,
    ex: Exports,
    jsrt: { JsFlat: { ofUnits(u: Uint16Array): unknown } },
  ) {
    this.h = h;
    this.meta = meta;
    this.ex = ex;
    this.jsrt = jsrt;
  }

  nullish(d: Desc): null | undefined {
    return d.nul === "null" ? null : undefined;
  }

  /** A JS value as printed TSL holds it. */
  toHost(d: Desc, v: unknown): unknown {
    const h = this.h;
    switch (d.k) {
      case "num":
        return d.rep === "f64" ? Number(v) : d.rep === "u32" ? Number(v) >>> 0 : Number(v) | 0;
      case "bool":
        return v === true;
      case "str": {
        const n = this.meta.strings[v as string];
        if (n === undefined)
          throw new TypeError(`a string this program doesn't know: ${String(v)}`);
        return n;
      }
      case "string": {
        if (v === null || v === undefined)
          return this.meta.strLayout !== undefined || this.meta.rcStr !== undefined ? null : 0;
        const s = v as string;
        if (this.meta.rcStr !== undefined) {
          // R10: placed as a native caller places one, by the module's own export, its units written in before it's used
          const p = this.ex.__str_place!(s.length) as { put(i: number, u: number): void };
          for (let i = 0; i < s.length; i++) p.put(i, s.charCodeAt(i));
          return p;
        }
        if (this.meta.strLayout !== undefined) {
          const u = new Uint16Array(s.length);
          for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
          return this.jsrt.JsFlat.ofUnits(u);
        }
        // D36's run-time string: its length at 0, its hash word at 4, its units' offset at 8, its units from 16.
        const p = h.block(16 + Math.max(1, s.length) * 2);
        h.write(p, s.length);
        h.write(p + 4, 0);
        h.write(p + 8, 16);
        for (let i = 0; i < s.length; i++) h.write(p + 16 + i * 2, s.charCodeAt(i));
        return p;
      }
      case "opt": {
        const missing = v === null || v === undefined;
        const of = d.of!;
        const zero =
          of.k === "bool" ? false : of.k === "str" ? Object.keys(this.meta.strings)[0] : 0;
        return h.pack(missing ? 0 : 1, this.toHost(of, missing ? zero : v));
      }
      case "arr": {
        if (v === null || v === undefined) return h.pack(0, 0);
        // A typed array is itself on the host: printed TSL indexes it, and its address is its own (@tsl/lowered).
        return v;
      }
      case "ref":
        if (v === null || v === undefined)
          return this.meta.tslClasses !== undefined && this.isClassed(d) ? null : 0;
        return this.toHeap(d, v);
      default:
        throw new Error(`printed-exec: an argument of kind ${d.k}`);
    }
  }

  toHeap(d: Desc, v: unknown): unknown {
    const hit = this.placed.get(v);
    if (hit !== undefined) return hit;
    const host = this.h;
    const hd = this.meta.heap[d.id!]!;
    if (hd.map !== undefined) {
      const m = this.ex[hd.map.make]!();
      this.placed.set(v, m);
      // R7: through the TSL route a JsMap or JsSet, read back through what it is
      const own = this.meta.tslMaps?.kinds[String(d.id)] !== undefined;
      this.objects.push(
        own ? { value: v, at: -1, h: hd, host: m } : { value: v, at: host.addrOf(m), h: hd },
      );
      const entries: [unknown, unknown][] =
        v instanceof Map
          ? [...(v as Map<unknown, unknown>)]
          : [...(v as Set<unknown>)].map((k) => [k, undefined]);
      for (const [k, x] of entries) {
        const args = [m, this.toHost(hd.map.keyDesc, k)];
        if (hd.map.kind === "map") args.push(this.toHost(hd.map.valDesc, x));
        this.ex[hd.map.put]!(...args);
      }
      return m;
    }
    if (hd.k === "vec" && hd.place !== undefined) {
      // R5: a JsArray, from the printed module's own placing export, its elements set as TSL sets them.
      const list = v as unknown[];
      const arr = this.ex[hd.place]!(list.length) as JsArrayHost;
      this.placed.set(v, arr);
      this.objects.push({ value: v, at: -1, h: hd, host: arr });
      for (let i = 0; i < list.length; i++)
        if (i in list) jsArr(arr).set(i, this.toHost(hd.elem!, list[i]));
      return arr;
    }
    const cls = this.meta.tslClasses?.[d.id!];
    if (cls !== undefined) {
      // R5: an instance of the printed class, each field by its TSL name (D36's offsets are the native caller's).
      const C = this.ex[cls.name] as unknown as new () => Record<string, unknown>;
      const o = new C();
      this.placed.set(v, o);
      this.objects.push({ value: v, at: -1, h: hd, host: o });
      for (const f of hd.fields!) {
        const fv = (v as Record<string, unknown>)[f.name];
        const cf = cls.fields[f.name]!;
        if (cf.arr === true) {
          // R7: a typed array is its runtime class's pointer and length (the printed class makes the holder)
          const l = host.leaves(this.toHost(f.ty, fv));
          const holder = o[cf.name] as { ptr: unknown; len: unknown };
          holder.ptr = l[0] ?? 0;
          holder.len = l[1] ?? 0;
          continue;
        }
        if (cf.value !== undefined) {
          // R7: an optional scalar is two fields, its flag and its value (zero where it's absent)
          const l = host.leaves(this.toHost(f.ty, fv));
          o[cf.name] = l[0] !== 0 && l[0] !== false;
          o[cf.value.name] = l[1];
          continue;
        }
        o[cf.name] = this.toHost(f.ty, fv);
      }
      return o;
    }
    if (hd.k === "vec") {
      const list = v as unknown[];
      const n = list.length;
      const cap = n < 4 ? 4 : n;
      const hdr = host.block(24);
      const data = host.block(cap * hd.slot!);
      host.write(hdr, data);
      host.write(hdr + 8, n);
      host.write(hdr + 16, cap);
      this.placed.set(v, hdr);
      this.objects.push({ value: v, at: hdr, h: hd });
      for (let i = 0; i < n; i++)
        if (i in list) host.write(data + i * hd.slot!, this.toHost(hd.elem!, list[i]));
      return hdr;
    }
    const at = host.block(hd.size!);
    this.placed.set(v, at);
    this.objects.push({ value: v, at, h: hd });
    for (const f of hd.fields!) {
      const fv =
        hd.tuple !== undefined
          ? (v as unknown[])[Number(f.name)]
          : (v as Record<string, unknown>)[f.name];
      host.write(at + f.off, this.toHost(f.ty, fv));
    }
    return at;
  }

  /** What printed TSL gave back, as the JS value a native caller reads (D36). */
  fromHost(d: Desc, v: unknown): unknown {
    const h = this.h;
    switch (d.k) {
      case "void":
        return undefined;
      case "num":
        return typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
      case "bool":
        return v !== 0 && v !== false && v !== 0n;
      case "str": {
        const n = Number(v);
        return Object.keys(this.meta.strings).find((s) => this.meta.strings[s] === n);
      }
      case "string":
        if (v === null || v === undefined || v === 0) return this.nullish(d);
        return this.textOf(v);
      case "opt": {
        const l = h.leaves(v);
        if (l[0] === 0 || l[0] === false || l[0] === undefined) return this.nullish(d);
        return this.fromHost(d.of!, l[1]);
      }
      case "arr": {
        if (isTypedArray(v)) return v;
        const [ptr, len] = h.leaves(v) as [number, number];
        if (ptr === 0 || ptr === undefined) return this.nullish(d);
        const out = new ARRAY[d.elem!]!(len);
        for (let i = 0; i < len; i++) out[i] = h.readElem(ptr, i, d.elem!) as number;
        return out;
      }
      case "ref": {
        if (this.meta.tslMaps?.kinds[String(d.id)] !== undefined) {
          if (v === null || v === undefined) return this.nullish(d);
          const hd = this.meta.heap[d.id!]!;
          const out: Map<unknown, unknown> | Set<unknown> =
            hd.map!.kind === "map" ? new Map() : new Set();
          this.fillJsMap(hd, out, v as JsMapHost);
          return out;
        }
        if (this.meta.tslClasses !== undefined && this.isClassed(d)) {
          if (v === null || v === undefined) return this.nullish(d);
          return this.fromClassed(d, v);
        }
        const p = h.addrOf(v);
        if (p === 0) return this.nullish(d);
        return this.fromHeap(d, p);
      }
      case "fn":
        return h.addrOf(v) === 0 ? this.nullish(d) : () => undefined;
      default:
        throw new Error(`printed-exec: a result of kind ${d.k}`);
    }
  }

  /** R5: whether what `d` refers to is the printed TSL's own: a boundary class, or a JsArray its export placed. */
  isClassed(d: Desc): boolean {
    const hd = this.meta.heap[d.id!]!;
    return (
      this.meta.tslClasses?.[d.id!] !== undefined || (hd.k === "vec" && hd.place !== undefined)
    );
  }

  /** R5: a printed class's instance or a JsArray, read back as the JS value a native caller reads at D36's offsets. */
  fromClassed(d: Desc, v: unknown): unknown {
    const hit = this.hostRead.get(v);
    if (hit !== undefined) return hit;
    const hd = this.meta.heap[d.id!]!;
    if (hd.k === "vec") {
      const out: unknown[] = [];
      this.hostRead.set(v, out);
      this.fillJsArray(hd, out, v as JsArrayHost);
      return out;
    }
    const out: Record<string, unknown> = {};
    this.hostRead.set(v, out);
    this.fillClassed(d.id!, hd, out, v as Record<string, unknown>);
    return out;
  }

  /** R7: a JsMap or JsSet on the host, read in its own order through its cursor, a number key from its bits. */
  fillJsMap(hd: Heap, out: Map<unknown, unknown> | Set<unknown>, m: JsMapHost): void {
    const mp = hd.map!;
    out.clear();
    const keyOf = (k: unknown): unknown => {
      if (mp.keyDesc.k === "num" && typeof k === "bigint") {
        const b = new DataView(new ArrayBuffer(8));
        b.setBigUint64(0, BigInt.asUintN(64, k));
        return this.fromHost(mp.keyDesc, b.getFloat64(0));
      }
      return this.fromHost(mp.keyDesc, k);
    };
    const c = m.cursor();
    while (m.advance(c)) {
      const k = keyOf(m.keyAt(c));
      if (out instanceof Map) out.set(k, this.fromHost(mp.valDesc, m.valAt(c)));
      else out.add(k);
    }
    m.close(c);
  }

  fillJsArray(hd: Heap, out: unknown[], holder: JsArrayHost): void {
    const a = jsArr(holder);
    const len = Number(a.length);
    out.length = len;
    for (let i = 0; i < len; i++) {
      const c = a.get(i);
      if (
        hd.holes === true &&
        (c === null || c === 0 || c === undefined) &&
        hd.elem!.nul === undefined
      ) {
        delete out[i];
        continue;
      }
      out[i] = this.fromHost(hd.elem!, c);
    }
  }

  fillClassed(
    id: number,
    hd: Heap,
    out: Record<string, unknown>,
    o: Record<string, unknown>,
  ): void {
    const cls = this.meta.tslClasses![id]!;
    for (const f of hd.fields!) {
      const cf = cls.fields[f.name]!;
      // R7: an optional scalar's two fields, packed as the value they are
      const holder = o[cf.name] as { ptr: unknown; len: unknown };
      const raw =
        cf.value !== undefined
          ? this.h.pack(o[cf.name], o[cf.value.name])
          : cf.arr === true
            ? this.h.pack(holder.ptr, holder.len)
            : o[cf.name];
      const v = this.fromHost(f.ty, raw);
      if (v === undefined && f.optional) {
        delete out[f.name];
        continue;
      }
      out[f.name] = v;
    }
  }

  /** A string printed TSL holds: a JsString (D67), or D36's run-time string in lowered memory. */
  textOf(v: unknown): string {
    if (typeof v === "object" && v !== null && "len" in v) {
      const s = v as { len(): number; unit(i: number): number };
      let out = "";
      for (let i = 0; i < s.len(); i++) out += String.fromCharCode(s.unit(i));
      return out;
    }
    const h = this.h;
    const p = h.addrOf(v);
    const n = Number(h.read(p));
    const at = p + Number(h.read(p + 8));
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(Number(h.read(at + i * 2)));
    return out;
  }

  /** A leaf in memory: a cell, or for a value of two leaves a cell holding both or two cells. */
  leafAt(at: number, d: Desc): unknown {
    const h = this.h;
    const c = h.read(at);
    if (d.k === "opt") {
      const l = h.leaves(c);
      return l.length > 1 ? c : h.pack(c, h.read(at + d.off!));
    }
    if (d.k === "arr") {
      if (isTypedArray(c) || h.leaves(c).length > 1) return c;
      return h.pack(c, h.read(at + 8));
    }
    return c;
  }

  fromHeap(d: Desc, p: number): unknown {
    const hit = this.read.get(p);
    if (hit !== undefined) return hit;
    const hd = this.meta.heap[d.id!]!;
    if (hd.k === "vec") {
      const out: unknown[] = [];
      this.read.set(p, out);
      this.fillVec(hd, out, p);
      return out;
    }
    if (hd.map !== undefined) {
      const made: Map<unknown, unknown> | Set<unknown> =
        hd.map.kind === "map" ? new Map() : new Set();
      this.read.set(p, made);
      this.fillMap(hd, made, p);
      return made;
    }
    if (hd.tuple !== undefined) {
      const made: unknown[] = Array.from({ length: hd.tuple });
      this.read.set(p, made);
      for (const f of hd.fields!)
        made[Number(f.name)] = this.fromHost(f.ty, this.leafAt(p + f.off, f.ty));
      return made;
    }
    const out: Record<string, unknown> = {};
    this.read.set(p, out);
    this.fillObj(hd, out, p);
    return out;
  }

  fillObj(hd: Heap, out: Record<string, unknown>, p: number): void {
    let names: string[] | null = null;
    if (hd.variants !== undefined && hd.variants.length > 0) {
      const tag = hd.fields!.find((f) => f.name === hd.variants![0]!.tag);
      if (tag !== undefined) {
        const value = this.fromHost(tag.ty, this.leafAt(p + tag.off, tag.ty));
        names = hd.variants.find((x) => x.value === value)?.fields ?? null;
      }
    }
    for (const f of hd.fields!) {
      if (names !== null && !names.includes(f.name)) continue;
      const v = this.fromHost(f.ty, this.leafAt(p + f.off, f.ty));
      if (v === undefined && f.optional) {
        delete out[f.name];
        continue;
      }
      out[f.name] = v;
    }
  }

  fillVec(hd: Heap, out: unknown[], p: number): void {
    const h = this.h;
    const data = h.addrOf(h.read(p));
    const len = Number(h.read(p + 8));
    out.length = len;
    for (let i = 0; i < len; i++) {
      const at = data + i * hd.slot!;
      const c = h.read(at);
      if (hd.holes === true && (c === 0 || c === undefined) && hd.elem!.nul === undefined) {
        delete out[i];
        continue;
      }
      out[i] = this.fromHost(hd.elem!, this.leafAt(at, hd.elem!));
    }
  }

  /** A map's entries in insertion order, by the runtime's own layout (compiler/rt/map.ts), as native-exec.ts reads them. */
  fillMap(hd: Heap, out: Map<unknown, unknown> | Set<unknown>, p: number): void {
    const h = this.h;
    const fieldOf = (x: Heap, name: string): Field =>
      (x.internal ?? x.fields!).find((f) => f.name === name)!;
    type V = { data: number; len: number; slot: number; elem: Desc };
    const vec = (x: Heap, at: number, name: string): V => {
      const f = fieldOf(x, name);
      const vp = h.addrOf(h.read(at + f.off));
      const vh = this.meta.heap[f.ty.id!]!;
      return {
        data: h.addrOf(h.read(vp)),
        len: Number(h.read(vp + 8)),
        slot: vh.slot!,
        elem: vh.elem!,
      };
    };
    const num = (x: Heap, at: number, name: string): number => {
      const f = fieldOf(x, name);
      return Number(this.fromHost(f.ty, this.leafAt(at + f.off, f.ty)));
    };
    const isMap = hd.map!.kind === "map";
    const table = (x: Heap, at: number): { keys: V; vals: V | null; chain: V } => ({
      keys: vec(x, at, "keys"),
      vals: isMap ? vec(x, at, "vals") : null,
      chain: vec(x, at, "chain"),
    });
    const elemAt = (v: V, i: number): unknown =>
      this.fromHost(v.elem, this.leafAt(v.data + i * v.slot, v.elem));
    const link = (t: { chain: V }, i: number): number => Number(elemAt(t.chain, i));
    const now = table(hd, p);
    out.clear();
    const take = (t: { keys: V; vals: V | null }, i: number): void => {
      const k = elemAt(t.keys, i);
      if (out instanceof Map) out.set(k, elemAt(t.vals!, i));
      else out.add(k);
    };
    const oldF = fieldOf(hd, "old");
    const op = h.addrOf(h.read(p + oldF.off));
    if (op === 0) {
      for (let i = 0; i < now.keys.len; i++) if (link(now, i) !== 0) take(now, i);
      return;
    }
    const old = table(this.meta.heap[oldF.ty.id!]!, op);
    const [mv, end, to, base] = [
      num(hd, p, "mv"),
      num(hd, p, "end"),
      num(hd, p, "to"),
      num(hd, p, "base"),
    ];
    for (let i = 0; i < to; i++) if (link(now, i) !== 0) take(now, i);
    for (let i = mv; i < end; i++) if (link(old, i) > 0) take(old, i);
    for (let i = base; i < now.keys.len; i++) if (link(now, i) !== 0) take(now, i);
  }

  /** What a case's arguments are after it: written back where the program writes through them, as natively. */
  writeBack(): void {
    for (const o of this.objects) {
      if ((o.h as { written?: boolean }).written !== true) continue;
      this.read.clear();
      this.hostRead.clear();
      if (o.host !== undefined) {
        // R5: the printed TSL's own instance or JsArray, read back through what it is; R7: or JsMap or JsSet.
        if (o.h.map !== undefined)
          this.fillJsMap(o.h, o.value as Map<unknown, unknown>, o.host as JsMapHost);
        else if (o.h.k === "vec")
          this.fillJsArray(o.h, o.value as unknown[], o.host as JsArrayHost);
        else {
          const id = Object.keys(this.meta.heap).find((k) => this.meta.heap[k] === o.h)!;
          this.fillClassed(Number(id), o.h, o.value as Record<string, unknown>, o.host as never);
        }
        continue;
      }
      if (o.h.k === "vec") this.fillVec(o.h, o.value as unknown[], o.at);
      else if (o.h.map !== undefined) this.fillMap(o.h, o.value as Map<unknown, unknown>, o.at);
      else if (o.h.tuple === undefined) this.fillObj(o.h, o.value as Record<string, unknown>, o.at);
    }
  }
}

// By a name tsc doesn't follow: the host's checks of tools/ are for erasable TS, and TSL packages aren't.
const LOWERED: string = "@tsl/lowered";
const JSRT: string = "@tsl/jsrt";

if (process.argv[1]?.endsWith("printed-exec.ts") === true) {
  const job = JSON.parse(process.argv[2]!) as Job;
  const cases = JSON.parse(readFileSync(job.cases, "utf8")) as LowerCase[];
  const meta = JSON.parse(readFileSync(job.meta, "utf8")) as Meta;
  const lowered = (await import(LOWERED)) as unknown as { hostLowered: Host };
  const jsrt = (await import(JSRT)) as unknown as {
    JsFlat: { ofUnits(u: Uint16Array): unknown };
  };
  lowered.hostLowered.setStrings(meta.strings);
  const ex = (await import(pathToFileURL(job.program).href)) as Exports;
  const out: LowerCaseResult[] = [];
  let init: unknown = null;
  try {
    ex.__init?.();
  } catch (e) {
    init = e;
  }
  // An export whose name a TSL module can't take is printed under another, with the lowering's tagged (E10).
  const byTag = new Map<string, string>();
  for (const m of readFileSync(job.program, "utf8").matchAll(
    /\/\*\* @tsl\.symbol (\S+) \*\/\nexport function ([\w$]+)/g,
  ))
    byTag.set(m[1]!, m[2]!);
  for (const c of cases) {
    const f = ex[byTag.get(c.fn) ?? c.fn];
    const desc = meta.exports[c.fn];
    if (typeof f !== "function" || desc === undefined) {
      out.push({ fn: c.fn, result: { missing: true }, args: null });
      continue;
    }
    const args = c.args.map(decodeArg);
    const m = new Marshal(lowered.hostLowered, meta, ex, jsrt);
    let result: unknown;
    try {
      if (init !== null) throw init;
      const hostArgs = desc.params.map((d, i) => m.toHost(d, args[i]));
      const r = f(...hostArgs);
      result = { value: strictCanon(desc.ret.k === "void" ? undefined : m.fromHost(desc.ret, r)) };
    } catch (e) {
      const err = e as { code?: unknown; constructor?: { name?: string } } | null;
      if (lowered.hostLowered.isThrow(e)) {
        if (meta.exc !== undefined && e.code === meta.exc.uncaught)
          result = thrownFromDesc(JSON.parse(unescapeUnits(e.text)) as never);
        else result = { threw: ERROR_NAMES.has(e.ctor) ? e.ctor : "Error", message: e.text };
      } else if (err?.constructor?.name === "TslTrap") result = { trap: err.code };
      else result = thrownCanon(e);
    }
    try {
      m.writeBack();
    } catch {
      // what the case left can't be read back: its arguments are as they went in
    }
    out.push({ fn: c.fn, result, args: strictCanon(args) });
  }
  process.stdout.write(JSON.stringify(out));
}
