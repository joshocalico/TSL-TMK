// The build store (SPEC 8.3, D45, D51): within one run of `tmk gate`, `tmk test` or `tmk milestone`, a compile asked for
// again with the same input is made once, and every later asker gets the same bytes. Nothing outlives the run: the gate
// names a directory of its own (TMK_STORE, under build/store/) and removes it at the end, so a run from `tmk clean` still
// made everything it used itself, from this tree. No result is stored: only what a compiler or a reference engine made.
//
// What an entry is keyed on: what kind of thing it is, the engine (Node's or Bun's version), the input file's path and bytes,
// the options, and every TMK_* and TSL_* variable but the few that only name a job's own paths. Inside the run the tree is
// fixed (the gate checks it before and after), so what's in it isn't keyed file by file; every file a compile read from
// outside it (a generated program in a job's directory, a printed package) is checked by its bytes when the entry is used.
//
// Checked, not trusted: a reuse is rebuilt from scratch and compared byte for byte one time in 16 (TMK_STORE_VERIFY=all for
// every one, =off for none), by the key and the run, so each run checks a different sixteenth. A difference is a mismatch:
// the asking suite throws, and the gate fails and says which. TMK_STORE=off turns the store off.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { threadId } from "node:worker_threads";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA = "tmk-store/1";

/** Inside the tree, fixed for the run: what a compile reads from here isn't checked file by file. */
const TREE_DIRS = ["compiler", "tools", "packages", "corpus", "bench", "node_modules"].map((d) =>
  join(ROOT, d),
);

/** Variables that name a job's own paths or the store itself: they don't change what's made. */
const NOT_KEYED = new Set([
  "TMK_BUILD_DIR",
  "TMK_LEVEL_TRACE",
  "TMK_SWEEP_LOG",
  "TMK_STORE",
  "TMK_STORE_VERIFY",
  "TMK_STORE_RUN",
  // the run's CPU budget (R12, tools/cpu-budget.ts): when work runs, never what it makes
  "TMK_CPU_SOCK",
  "TMK_CPU_TOKENS",
]);

export function storeDir(): string | null {
  const d = process.env.TMK_STORE;
  return d === undefined || d === "" || d === "off" ? null : d;
}

const engine = (): string =>
  (globalThis as { Bun?: { version: string } }).Bun !== undefined
    ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
    : `node ${process.version}`;

/** Every variable that can change what's made, as one string. */
export function keyedEnv(): string {
  return Object.keys(process.env)
    .filter((k) => /^(TMK_|TSL_)/.test(k) && !NOT_KEYED.has(k))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .concat(`NODE_OPTIONS=${process.env.NODE_OPTIONS ?? ""}`)
    .join("\0");
}

const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function storeKey(kind: string, parts: (string | Uint8Array)[]): string {
  const h = createHash("sha256").update(`${SCHEMA}\0${kind}\0${engine()}\0${keyedEnv()}`);
  for (const p of parts) h.update("\0").update(p);
  return h.digest("hex");
}

// --- what a compile reads from outside the tree

let reading: Set<string> | null = null;
const realRead = fs.readFileSync;

/** Runs f, noting every file it reads from outside the tree, by its bytes now. */
function withReads<T>(f: () => T): { value: T; reads: { path: string; sha: string }[] } {
  const seen = new Set<string>();
  const outer = reading;
  reading = seen;
  (fs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...a: unknown[]) {
    const p = a[0];
    if (typeof p === "string" || p instanceof URL) {
      const abs = resolve(p instanceof URL ? fileURLToPath(p) : p);
      if (!TREE_DIRS.some((d) => abs.startsWith(`${d}/`))) seen.add(abs);
    }
    return (realRead as (...x: unknown[]) => unknown).apply(this, a);
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const value = f();
    return {
      value,
      reads: [...seen].sort().map((path) => ({
        path,
        sha: existsSync(path) ? sha(realRead(path)) : "absent",
      })),
    };
  } finally {
    (fs as { readFileSync: unknown }).readFileSync = realRead;
    syncBuiltinESMExports();
    reading = outer;
    if (outer !== null) for (const p of seen) outer.add(p);
  }
}

// --- the counts, for the gate's manifest

function count(
  what: "hit" | "miss" | "verified" | "mismatch" | "stale",
  kind: string,
  ms = 0,
): void {
  const d = storeDir();
  if (d === null) return;
  mkdirSync(join(d, "events"), { recursive: true });
  appendFileSync(
    join(d, "events", `${process.pid}-${threadId}`),
    `${what} ${kind} ${Math.round(ms)}\n`,
  );
}

/** Whether this reuse is one of the run's sixteenth to rebuild, by the key and the run. */
function sampled(key: string): boolean {
  const v = process.env.TMK_STORE_VERIFY ?? "sample";
  if (v === "off") return false;
  if (v === "all") return true;
  return parseInt(sha(`${key}\0${process.env.TMK_STORE_RUN ?? ""}`).slice(0, 4), 16) % 16 === 0;
}

export class StoreMismatch extends Error {}

/**
 * Whether a compile is one of the run's sixteenth made again with tslc's reuse off (T2, compiler/host/program.ts), by its key
 * and the run, salted apart from the store's own sixteenth: TMK_COMPILE_REUSE=verify for every one, =off for none (there's
 * nothing to check).
 */
export function reuseSampled(key: string): boolean {
  const v = process.env.TMK_COMPILE_REUSE ?? "on";
  if (v === "off") return false;
  if (v === "verify") return true;
  return (
    parseInt(sha(`reuse\0${key}\0${process.env.TMK_STORE_RUN ?? ""}`).slice(0, 4), 16) % 16 === 0
  );
}

/** A check made beside the store (a compile made again cold, T2): counted as its own are, and a difference kept as theirs. */
export function noteCheck(kind: string, ok: boolean, what: string, ms = 0): void {
  const d = storeDir();
  if (d === null) return;
  if (ok) {
    count("verified", kind, ms);
    return;
  }
  count("mismatch", kind);
  mkdirSync(join(d, "mismatches"), { recursive: true });
  writeFileSync(
    join(d, "mismatches", `${kind}-${sha(`${what}\0${process.pid}`).slice(0, 16)}.json`),
    JSON.stringify({ kind, what, pid: process.pid, env: keyedEnv() }),
  );
}

/**
 * A value's hash by what it is, not how V8 holds it: v8's serializer writes the same strings and buffers differently after a
 * round trip (MEASURED: images and placements identical, bytes not), so a check compares this. Keys in their order (which a
 * program's iteration sees), Maps and Sets in theirs, typed arrays by their bytes, a shared object by where it was first seen.
 */
export function valueHash(v: unknown, skipKeys: ReadonlySet<string> = new Set()): string {
  const h = createHash("sha256");
  const seen = new Map<object, number>();
  const walk = (x: unknown): void => {
    if (x === null) return void h.update("n");
    switch (typeof x) {
      case "undefined":
        return void h.update("u");
      case "boolean":
        return void h.update(x ? "T" : "F");
      case "number":
        return void h.update(`d${Object.is(x, -0) ? "-0" : String(x)};`);
      case "bigint":
        return void h.update(`b${x.toString()};`);
      case "string":
        return void h.update(`s${x.length}:`).update(x);
      case "function":
      case "symbol":
        return void h.update(`?${typeof x}`);
    }
    const o = x as object;
    const at = seen.get(o);
    if (at !== undefined) return void h.update(`r${at};`);
    seen.set(o, seen.size);
    if (ArrayBuffer.isView(o)) {
      const b = Buffer.from(o.buffer, o.byteOffset, o.byteLength);
      return void h.update(`v${o.constructor.name}${b.length}:`).update(b);
    }
    if (o instanceof ArrayBuffer) return void h.update(`B${o.byteLength}:`).update(Buffer.from(o));
    if (Array.isArray(o)) {
      h.update(`a${o.length}[`);
      for (const e of o) walk(e);
      return void h.update("]");
    }
    if (o instanceof Map) {
      h.update(`m${o.size}{`);
      for (const [k, e] of o) {
        walk(k);
        walk(e);
      }
      return void h.update("}");
    }
    if (o instanceof Set) {
      h.update(`t${o.size}{`);
      for (const e of o) walk(e);
      return void h.update("}");
    }
    if (o instanceof Date) return void h.update(`D${o.getTime()};`);
    if (o instanceof RegExp) return void h.update(`R${o.toString()};`);
    h.update("o{");
    for (const k of Object.keys(o)) {
      if (skipKeys.has(k)) continue;
      h.update(`k${k.length}:`).update(k);
      walk((o as Record<string, unknown>)[k]);
    }
    h.update("}");
  };
  walk(v);
  return h.digest("hex");
}

interface Entry<T> {
  value: T;
  reads: { path: string; sha: string }[];
  /** How many times making it took the optimiser's level from the environment (manager.ts): noted again on reuse. */
  envLevel: boolean;
}

/**
 * The stored value for a key, or what `make` makes, stored. `encode`/`decode` turn it into bytes and back (v8's serializer by
 * default); what's compared on a check is those bytes. `onReuse` does what making it would have done besides its value
 * (the level trace's note).
 */
export function stored<T>(
  kind: string,
  key: string,
  make: () => T,
  hooks: {
    envLevel?: () => number;
    onEnvLevel?: () => void;
    describe?: string;
    /** Whether a stored value can still be used as it is (a printed package it names is there). */
    usable?: (v: T) => boolean;
    /** Keys that hold how long making it took (a compile's `ms`): not what was made, so not compared. */
    timings?: ReadonlySet<string>;
  } = {},
): T {
  const d = storeDir();
  if (d === null) return make();
  const file = join(d, kind, key.slice(0, 2), key);
  const levelBefore = hooks.envLevel?.() ?? 0;
  const fresh = (): { bytes: Buffer; entry: Entry<T>; ms: number } => {
    const t = performance.now();
    const { value, reads } = withReads(make);
    const entry: Entry<T> = {
      value,
      reads,
      envLevel: (hooks.envLevel?.() ?? 0) > levelBefore,
    };
    const ms = performance.now() - t;
    return { bytes: serialize(value), entry, ms };
  };
  if (existsSync(file)) {
    let have: {
      bytes: Buffer;
      reads: Entry<T>["reads"];
      envLevel: boolean;
      ms: number;
    } | null = null;
    try {
      const raw = deserialize(realRead(file)) as {
        bytes: Uint8Array;
        reads: Entry<T>["reads"];
        envLevel: boolean;
        ms: number;
      };
      have = { ...raw, bytes: Buffer.from(raw.bytes) };
    } catch {
      have = null;
    }
    // What it read from outside the tree has to be what's there now.
    const current =
      have !== null &&
      have.reads.every((r) => (existsSync(r.path) ? sha(realRead(r.path)) : "absent") === r.sha);
    if (have !== null && current) {
      if (sampled(key)) {
        const f = fresh();
        // By value: a stored value read back is the value stored (MEASURED; tools/store.test.ts), and hashing only here
        // spares every build that's never checked the cost of it.
        if (
          valueHash(f.entry.value, hooks.timings) !==
          valueHash(deserialize(have.bytes), hooks.timings)
        ) {
          count("mismatch", kind);
          const why = `the build store's ${kind} for ${hooks.describe ?? key} was made again and differs from what was stored (key ${key})`;
          mkdirSync(join(d, "mismatches"), { recursive: true });
          writeFileSync(
            join(d, "mismatches", `${key}.json`),
            JSON.stringify({
              kind,
              key,
              what: hooks.describe ?? "",
              pid: process.pid,
              env: keyedEnv(),
            }),
          );
          throw new StoreMismatch(why);
        }
        count("verified", kind, f.ms);
        return f.entry.value;
      }
      const v = deserialize(have.bytes) as T;
      if (hooks.usable === undefined || hooks.usable(v)) {
        if (have.envLevel) hooks.onEnvLevel?.();
        count("hit", kind, have.ms);
        return v;
      }
    }
    if (have !== null) count("stale", kind);
  }
  const f = fresh();
  count("miss", kind, f.ms);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${threadId}.${randomBytes(4).toString("hex")}`;
    writeFileSync(
      tmp,
      serialize({
        bytes: f.bytes,
        reads: f.entry.reads,
        envLevel: f.entry.envLevel,
        ms: f.ms,
      }),
    );
    renameSync(tmp, file);
  } catch {
    // A store that can't be written is a store that isn't used: the value is still right.
  }
  return f.entry.value;
}

/** JSON with every object's keys in order: the same options from two callers are one key. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof Uint8Array)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

/** A file's bytes and path, for a key: where it is matters as much as what's in it (a module resolves imports from there). */
export function fileKey(file: string): string[] {
  const abs = resolve(file);
  return [relative(ROOT, abs), existsSync(abs) ? sha(realRead(abs)) : "absent"];
}

// --- the gate's side

export interface StoreStats {
  dir: string;
  verify: string;
  byKind: Record<
    string,
    {
      hit: number;
      miss: number;
      verified: number;
      mismatch: number;
      stale: number;
      msSaved: number;
    }
  >;
  mismatches: string[];
}

/** What the run's store did: every process's and thread's events, summed. */
export function storeStats(dir: string): StoreStats {
  const byKind: StoreStats["byKind"] = {};
  const ev = join(dir, "events");
  if (existsSync(ev))
    for (const f of fs.readdirSync(ev))
      for (const line of realRead(join(ev, f), "utf8").split("\n")) {
        const [what, kind, ms] = line.split(" ");
        if (what === undefined || kind === undefined || what === "") continue;
        const k = (byKind[kind] ??= {
          hit: 0,
          miss: 0,
          verified: 0,
          mismatch: 0,
          stale: 0,
          msSaved: 0,
        });
        (k as Record<string, number>)[what] = ((k as Record<string, number>)[what] ?? 0) + 1;
        if (what === "hit") k.msSaved += Number(ms ?? 0);
      }
  const mm = join(dir, "mismatches");
  const mismatches = existsSync(mm)
    ? fs.readdirSync(mm).map((f) => realRead(join(mm, f), "utf8"))
    : [];
  return { dir, verify: process.env.TMK_STORE_VERIFY ?? "sample", byKind, mismatches };
}

// --- what a pure child printed: the pins tools and the reference engines' runs (fix 2 of the test-speed round, D45)

/**
 * The same, for something made asynchronously (a child's output). Only what `make` says is complete is stored (a child that
 * failed, timed out or ran out of memory is never stored: its run depends on the load).
 */
export async function storedAsync<T>(
  kind: string,
  key: string,
  make: () => Promise<{ value: T; keep: boolean }>,
  describe: string,
  /** What's compared of it on a check: a child's output and exit, not how long it took or its memory. */
  compared: (v: T) => unknown = (v) => v,
): Promise<{ value: T; reused: boolean }> {
  const d = storeDir();
  if (d === null) return { value: (await make()).value, reused: false };
  const file = join(d, kind, key.slice(0, 2), key);
  const fresh = async (): Promise<{
    bytes: Buffer;
    value: T;
    keep: boolean;
    ms: number;
  }> => {
    const t = performance.now();
    const r = await make();
    const ms = performance.now() - t;
    return {
      bytes: serialize(r.value),
      value: r.value,
      keep: r.keep,
      ms,
    };
  };
  if (existsSync(file)) {
    let have: { bytes: Buffer; ms: number } | null = null;
    try {
      const raw = deserialize(realRead(file)) as { bytes: Uint8Array; ms: number };
      have = { bytes: Buffer.from(raw.bytes), ms: raw.ms };
    } catch {
      have = null;
    }
    if (have !== null) {
      if (sampled(key)) {
        const f = await fresh();
        if (!f.keep) return { value: f.value, reused: false }; // it failed this time: that's its own result, and seen
        if (valueHash(compared(f.value)) !== valueHash(compared(deserialize(have.bytes) as T))) {
          count("mismatch", kind);
          mkdirSync(join(d, "mismatches"), { recursive: true });
          writeFileSync(
            join(d, "mismatches", `${key}.json`),
            JSON.stringify({ kind, key, what: describe, pid: process.pid, env: keyedEnv() }),
          );
          throw new StoreMismatch(
            `the build store's ${kind} for ${describe} was run again and differs from what was stored (key ${key})`,
          );
        }
        count("verified", kind, f.ms);
        return { value: f.value, reused: false };
      }
      count("hit", kind, have.ms);
      return { value: deserialize(have.bytes) as T, reused: true };
    }
  }
  const f = await fresh();
  if (!f.keep) return { value: f.value, reused: false };
  count("miss", kind, f.ms);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${threadId}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, serialize({ bytes: f.bytes, ms: f.ms }));
    renameSync(tmp, file);
  } catch {
    // Not stored: still right.
  }
  return { value: f.value, reused: false };
}

/** Scripts whose output is a function of their arguments, the files those name, the tree and the environment. */
const PURE: Record<string, (job: Record<string, unknown> | null) => boolean> = {
  "pre-std-hashes.ts": () => true,
  "pre-strings-hashes.ts": () => true,
  "strict-hashes.ts": () => true,
  "mode-hashes.ts": () => true,
  "rc-off-hashes.ts": () => true,
  "opt-hashes.ts": () => true,
  // The reference engines: a program's source on V8 or JSC, and a printed package run unchanged on them.
  "lower-exec.ts": (j) => j?.mode === "source",
  "corpus-exec.ts": (j) => j?.mode === "source",
  "printed-exec.ts": () => true,
};

/** A path's bytes for a key: a file's, or every file's under a directory (a printed package), in order. */
function pathBytes(abs: string): string {
  if (!existsSync(abs)) return "absent";
  const st = fs.statSync(abs);
  if (st.isFile()) return sha(realRead(abs));
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(relative(abs, p)).update("\0").update(realRead(p));
    }
  };
  walk(abs);
  return h.digest("hex");
}

/**
 * The store key of a child's run, or null if it isn't one that can be reused. Every absolute path in its arguments (and in a
 * JSON argument's strings) that's outside the tree is replaced by its bytes: a printed package by its whole directory, a
 * meta file in a job's directory by its own. The engine is the command itself.
 */
export function childKey(cmd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  if (storeDir() === null) return null;
  const script = args.find((a) => a.endsWith(".ts") && !a.startsWith("{"));
  if (script === undefined) return null;
  const name = script.slice(script.lastIndexOf("/") + 1);
  const pure = PURE[name];
  // This tree's tools only. (Not a path literal: `--changed` would read one as data every job reaches, tools/deps.ts.)
  if (pure === undefined || !resolve(script).startsWith(`${join(ROOT, "tools")}/`)) return null;
  let job: Record<string, unknown> | null = null;
  const jsonArg = args.find((a) => a.startsWith("{"));
  if (jsonArg !== undefined)
    try {
      job = JSON.parse(jsonArg) as Record<string, unknown>;
    } catch {
      return null;
    }
  if (!pure(job)) return null;
  const outside = (p: string): string => {
    const abs = resolve(p);
    if (TREE_DIRS.some((d) => abs.startsWith(`${d}/`))) return relative(ROOT, abs);
    const tsl = /^(.*\/build\/tsl\/[0-9a-f]+)(\/.*)?$/.exec(abs);
    if (tsl !== null) return `pkg:${pathBytes(tsl[1]!)}:${tsl[2] ?? ""}`;
    return `file:${pathBytes(abs)}`;
  };
  const norm = (a: string): string => {
    if (a.startsWith("{")) {
      return canonical(
        JSON.parse(a, (_k, v: unknown) =>
          typeof v === "string" && v.startsWith("/") ? outside(v) : v,
        ),
      );
    }
    return a.startsWith("/") ? outside(a) : a;
  };
  const keyedChildEnv = Object.keys(env)
    .filter((k) => /^(TMK_|TSL_|BUN_)/.test(k) && !NOT_KEYED.has(k))
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\0");
  return createHash("sha256")
    .update(`${SCHEMA}\0child\0${cmd}\0${keyedChildEnv}\0NODE_OPTIONS=${env.NODE_OPTIONS ?? ""}`)
    .update(args.map(norm).join("\0"))
    .digest("hex");
}
