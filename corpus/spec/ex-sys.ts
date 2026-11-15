// file: ex-sys.ts
import { u32, u64, type Int, type Result, type u8, type usize } from "@tsl/core";

declare const capOf: unique symbol;
export type CapKind =
  | "domain" | "thread" | "endpoint" | "notification" | "frame"
  | "addrspace" | "irq" | "mmio" | "dma" | "quota";
export type Cap<K extends CapKind> = Int<"cap"> & { readonly [capOf]?: K };
export type AnyCap = Cap<CapKind>;

export type SysError = u32;
export const E_BAD_CAP: SysError = 1, E_RIGHTS: SysError = 2, E_NO_MEM: SysError = 3, E_INVAL: SysError = 4,
  E_BUSY: SysError = 5, E_DEAD: SysError = 6, E_RANGE: SysError = 7, E_CANCELLED: SysError = 8;
export type Sys<T> = Result<T, SysError>;

export class Msg {
  w0 = u64();
  w1 = u64();
  w2 = u64();
  w3 = u64();
  w4 = u64();
  w5 = u64();
  cap = u32(); // 0 means no capability transferred
  badge = u32(); // Set by the kernel on receive
}

// --- capabilities
/* 1  */ export declare function capCopy(src: AnyCap, rightsMask: u8, badge: u64): Sys<AnyCap>;
/* 2  */ export declare function capDelete(c: AnyCap): Sys<0>;
/* 3  */ export declare function capRevoke<K extends CapKind>(c: Cap<K>): Sys<Cap<K>>;
/* 4  */ export declare function capInfo(c: AnyCap): Sys<{ readonly kind: u8; readonly rights: u8 }>;

// --- memory
/* 10 */ export declare function frameAlloc(q: Cap<"quota">, pages: usize): Sys<Cap<"frame">>;
/* 11 */ export declare function asCreate(q: Cap<"quota">): Sys<Cap<"addrspace">>;
/* 12 */ export declare function asMap(as: Cap<"addrspace">, f: Cap<"frame">, va: u64, flags: u32): Sys<0>;
/* 13 */ export declare function asUnmap(as: Cap<"addrspace">, va: u64, pages: usize): Sys<0>;
/* 14 */ export declare function quotaSplit(q: Cap<"quota">, bytes: u64): Sys<Cap<"quota">>;

// --- domains and threads
/* 20 */ export declare function domainCreate(q: Cap<"quota">, as: Cap<"addrspace">, slots: u32): Sys<Cap<"domain">>;
/* 21 */ export declare function domainGrant(d: Cap<"domain">, c: AnyCap): Sys<AnyCap>;
/* 22 */ export declare function domainKill(d: Cap<"domain">): Sys<0>;
/* 23 */ export declare function domainSetFaultEp(d: Cap<"domain">, ep: Cap<"endpoint">): Sys<0>;
/* 24 */ export declare function threadCreate(d: Cap<"domain">, pc: u64, sp: u64, arg: u64, priority: u8): Sys<Cap<"thread">>;
/* 25 */ export declare function threadStart(t: Cap<"thread">): Sys<0>;
/* 26 */ export declare function threadSetPriority(t: Cap<"thread">, priority: u8): Sys<0>;
/* 27 */ export declare function threadYield(): Sys<0>;
/* 28 */ export declare function threadExit(status: u32): never;
/* 29 */ export declare function threadCancel(t: Cap<"thread">): Sys<0>;

// --- IPC
/* 30 */ export declare function epCreate(q: Cap<"quota">): Sys<Cap<"endpoint">>;
/* 31 */ export declare function epCall(ep: Cap<"endpoint">, inout: Msg): Sys<0>;
/* 32 */ export declare function epRecv(ep: Cap<"endpoint">, out: Msg): Sys<0>;
/* 33 */ export declare function epReplyRecv(ep: Cap<"endpoint">, inout: Msg): Sys<0>;
/* 34 */ export declare function ntfnCreate(q: Cap<"quota">): Sys<Cap<"notification">>;
/* 35 */ export declare function ntfnSignal(n: Cap<"notification">, bits: u64): Sys<0>;
/* 36 */ export declare function ntfnWait(n: Cap<"notification">): Sys<u64>;
/* 37 */ export declare function domainWatch(d: Cap<"domain">, n: Cap<"notification">, bit: u32): Sys<0>;
/* 38 */ export declare function epWatchCallers(ep: Cap<"endpoint">, n: Cap<"notification">, bit: u32): Sys<0>;

// --- devices
/* 40 */ export declare function irqBind(irq: Cap<"irq">, n: Cap<"notification">, bit: u32): Sys<0>;
/* 41 */ export declare function irqAck(irq: Cap<"irq">): Sys<0>;
/* 42 */ export declare function mmioMap(m: Cap<"mmio">, as: Cap<"addrspace">, va: u64): Sys<0>;
/* 43 */ export declare function dmaAlloc(q: Cap<"quota">, as: Cap<"addrspace">, va: u64, pages: usize): Sys<{ readonly dma: Cap<"dma">; readonly physAddr: u64 }>;

// --- misc
/* 50 */ export declare function clockNowNs(): Sys<u64>;
/* 51 */ export declare function debugWrite(bytes: Uint8Array): Sys<usize>; // Only if the domain holds debug rights
/* 52 */ export declare function systemOff(d: Cap<"domain">): never; // Requires the init domain capability
