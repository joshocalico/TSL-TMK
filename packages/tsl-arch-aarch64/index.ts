// @tsl/arch-aarch64 on the host: each intrinsic records its call and does nothing, unless a test installs a
// handler (Appendix A). Natively these are single instructions, out of scope until the kernel uses them.
import type { u32, u64 } from "@tsl/core";

export const calls: string[] = [];
export const handlers = new Map<string, (...args: bigint[]) => bigint>();

function run(name: string, ...args: bigint[]): bigint {
  calls.push(args.length > 0 ? `${name}=${args.map((a) => a.toString(16)).join(",")}` : name);
  return handlers.get(name)?.(...args) ?? 0n;
}

export function dmbIsh(): void {
  run("dmbIsh");
}
export function dmbIshSt(): void {
  run("dmbIshSt");
}
export function dmbIshLd(): void {
  run("dmbIshLd");
}
export function dmbOsh(): void {
  run("dmbOsh");
}
export function dmbOshSt(): void {
  run("dmbOshSt");
}
export function dsbSy(): void {
  run("dsbSy");
}
export function dsbIsh(): void {
  run("dsbIsh");
}
export function dsbIshSt(): void {
  run("dsbIshSt");
}
export function dsbNsh(): void {
  run("dsbNsh");
}
export function isb(): void {
  run("isb");
}
export function sb(): void {
  run("sb");
}
export function csdb(): void {
  run("csdb");
}
export function wfi(): void {
  run("wfi");
}
export function wfe(): void {
  run("wfe");
}
export function sev(): void {
  run("sev");
}
export function eret(): never {
  run("eret");
  throw new Error("eret does not return on the host");
}
export function maskIrq(): void {
  run("maskIrq");
}
export function unmaskIrq(): void {
  run("unmaskIrq");
}
export function dcCvac(addr: u64): void {
  run("dcCvac", addr);
}
export function dcCivac(addr: u64): void {
  run("dcCivac", addr);
}
export function dcIvac(addr: u64): void {
  run("dcIvac", addr);
}
export function icIallu(): void {
  run("icIallu");
}
export function tlbiVmalle1(): void {
  run("tlbiVmalle1");
}
export function tlbiAside1(asid: u64): void {
  run("tlbiAside1", asid);
}
export function tlbiVale1(arg: u64): void {
  run("tlbiVale1", arg);
}
export function hvc0(a0: u64, a1: u64, a2: u64, a3: u64): u64 {
  return run("hvc0", a0, a1, a2, a3);
}
export function svc0(n: u64, a0: u64, a1: u64, a2: u64, a3: u64, a4: u64, a5: u64): u64 {
  return run("svc0", n, a0, a1, a2, a3, a4, a5);
}
export function readCurrentEl(): u64 {
  return run("readCurrentEl");
}
export function readMidrEl1(): u64 {
  return run("readMidrEl1");
}
export function readIdAa64Pfr0El1(): u64 {
  return run("readIdAa64Pfr0El1");
}
export function readIdAa64Pfr1El1(): u64 {
  return run("readIdAa64Pfr1El1");
}
export function readIdAa64Isar0El1(): u64 {
  return run("readIdAa64Isar0El1");
}
export function readIdAa64Isar1El1(): u64 {
  return run("readIdAa64Isar1El1");
}
export function readIdAa64Mmfr0El1(): u64 {
  return run("readIdAa64Mmfr0El1");
}
export function readIdAa64Mmfr1El1(): u64 {
  return run("readIdAa64Mmfr1El1");
}
export function readSctlrEl1(): u64 {
  return run("readSctlrEl1");
}
export function writeSctlrEl1(v: u64): void {
  run("writeSctlrEl1", v);
}
export function writeTcrEl1(v: u64): void {
  run("writeTcrEl1", v);
}
export function writeMairEl1(v: u64): void {
  run("writeMairEl1", v);
}
export function writeTtbr0El1(v: u64): void {
  run("writeTtbr0El1", v);
}
export function writeTtbr1El1(v: u64): void {
  run("writeTtbr1El1", v);
}
export function writeVbarEl1(v: u64): void {
  run("writeVbarEl1", v);
}
export function readEsrEl1(): u64 {
  return run("readEsrEl1");
}
export function readFarEl1(): u64 {
  return run("readFarEl1");
}
export function readElrEl1(): u64 {
  return run("readElrEl1");
}
export function writeElrEl1(v: u64): void {
  run("writeElrEl1", v);
}
export function writeSpsrEl1(v: u64): void {
  run("writeSpsrEl1", v);
}
export function writeSpEl0(v: u64): void {
  run("writeSpEl0", v);
}
export function readCntfrqEl0(): u64 {
  return run("readCntfrqEl0");
}
export function readCntvctEl0(): u64 {
  return run("readCntvctEl0");
}
export function writeCntvTvalEl0(v: u64): void {
  run("writeCntvTvalEl0", v);
}
export function writeCntvCtlEl0(v: u64): void {
  run("writeCntvCtlEl0", v);
}
export function writeCntkctlEl1(v: u64): void {
  run("writeCntkctlEl1", v);
}
export function readIccIar1El1(): u32 {
  return Number(run("readIccIar1El1"));
}
export function writeIccEoir1El1(v: u32): void {
  run("writeIccEoir1El1", BigInt(v));
}
export function readIccSreEl1(): u64 {
  return run("readIccSreEl1");
}
export function writeIccSreEl1(v: u64): void {
  run("writeIccSreEl1", v);
}
export function writeIccPmrEl1(v: u64): void {
  run("writeIccPmrEl1", v);
}
export function writeIccIgrpen1El1(v: u64): void {
  run("writeIccIgrpen1El1", v);
}
