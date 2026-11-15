// What the lowered runtime (SPEC 4.5, D42) asks the compiler for directly. Each `declare` below has no body: down.ts lowers a
// call to it in place, by the argument's shape. Nothing here runs on a JS engine. `compiler/rt` is ordinary TS, lowered
// by down.ts into the module that reaches it, so counts, descriptors and the collector's barrier are the compiler's job.

// --- a string's memory: [len: u32][hash: u32][off: i64][...]. Its units are at `s + off`.
export declare function __s_len(s: string): number;
export declare function __s_unit(s: string, i: number): number;
export declare function __s_alloc(hdr: number, units: number): string; // zeroed, with len and off set
export declare function __s_put(s: string, i: number, u: number): void;
export declare function __s_copy(d: string, di: number, s: string, si: number, n: number): void;
export declare function __s_view(owner: string, start: number, n: number): string;
export declare function __s_owner(s: string): string; // a view's owner, read like any counted field
export declare function __s_get(s: string, off: number): number; // a header word
export declare function __s_set(s: string, off: number, v: number): void;
export declare function __s_same(a: string, b: string): boolean; // the same pointer
export declare function __s_null(a: string): boolean; // string | null | undefined, already narrowed to string
export declare function __s_char(u: number): string; // u below 256: from a static table
export declare function __hash_k(i: number): number; // a word of the hash key, which a caller can set

// --- doubles
export declare function __f64_hi(x: number): number;
export declare function __f64_lo(x: number): number;
export declare function __f64_make(hi: number, lo: number): number;

// A double stays a double: Math.floor and friends give an i32, and trap past its range, unless the result is known float.
export declare function __trap(code: Trap): never;
// @tsl/core's trap codes by name (3.10, D71): `__trap(Trap.Conversion)`. Declared, not imported: the runtime never runs on a
// JS engine, and down.ts reads a code from its type.
export declare const Trap: typeof import("@tsl/core").Trap;
export type Trap = import("@tsl/core").Trap;
export declare function __fault(name: string): boolean; // a test build's injected mistake: false in anything that ships
export declare function __f64(x: number): number; // this location is a double, whatever flows into it
export declare function __f_floor(x: number): number;
export declare function __f_ceil(x: number): number;
export declare function __f_trunc(x: number): number;

// --- vectors, without what JS semantics add: no bounds check, and no holes to think about
export declare function __v_at<T>(a: T[], i: number): T;
export declare function __v_put<T>(a: T[], i: number, v: T): void; // i is below the length
export declare function __v_clear<T>(a: T[], i: number): void; // releases a slot, and leaves a hole in a reference slot
export declare function __v_move<T>(a: T[], from: number, to: number): void; // to is free, and from is left free
export declare function __v_cut<T>(a: T[], n: number): void; // the slots above n have been moved from
export declare function __v_hole<T>(a: T[], i: number): boolean;
// An empty vector given room for `cap` elements and a length of `n` at most that: one allocation, and its slots are zero, so
// nothing later grows it by copying, and a reference slot below `n` is a hole until it's written (SPEC 3.5, D47).
export declare function __v_size<T>(a: T[], cap: number, n: number): void;

// --- what a type parameter is, in this instantiation
export declare function __k_hash<K>(k: K): number;
export declare function __k_same<K>(a: K, b: K): boolean; // SameValueZero
export declare function __k_norm<K>(k: K): K; // -0 to +0
export declare function __has_vals<_V>(): boolean; // false for a Set's map
export declare function __is_str<_T>(): boolean;
export declare function __to_str<T>(x: T): string; // ToString
export declare function __join_str<T>(x: T): string; // ToString, with null and undefined as ""
export declare function __hole<T>(): T; // a value no one reads: a tombstone, for a type with no empty form

// --- classes and exceptions (SPEC 4.5, D49, D50)
export declare function __dyn_class_name(e: unknown): string; // the constructor's name, as JS's `constructor.name`
