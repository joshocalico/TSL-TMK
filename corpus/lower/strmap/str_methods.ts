// Every string method lowered, one export each, so generated cases can drive any of them with any input.
export function length(s: string): number {
  return s.length;
}
export function charCodeAt(s: string, i: number): number {
  return s.charCodeAt(i);
}
export function codePointAt(s: string, i: number): number | undefined {
  return s.codePointAt(i);
}
export function index(s: string, i: number): string | undefined {
  return s[i];
}
export function charAt(s: string, i: number): string {
  return s.charAt(i);
}
export function at(s: string, i: number): string | undefined {
  return s.at(i);
}
export function eq(a: string, b: string): boolean {
  return a === b;
}
export function ne(a: string, b: string): boolean {
  return a !== b;
}
export function lt(a: string, b: string): boolean {
  return a < b;
}
export function le(a: string, b: string): boolean {
  return a <= b;
}
export function gt(a: string, b: string): boolean {
  return a > b;
}
export function ge(a: string, b: string): boolean {
  return a >= b;
}
export function concat(a: string, b: string): string {
  return a + b;
}
export function concat3(a: string, b: string, c: string): string {
  return a.concat(b, c);
}
export function tpl(a: string, n: number, b: boolean): string {
  return `<${a}|${n}|${b}>`;
}
export function slice(s: string, a: number, b: number): string {
  return s.slice(a, b);
}
export function slice1(s: string, a: number): string {
  return s.slice(a);
}
export function substring(s: string, a: number, b: number): string {
  return s.substring(a, b);
}
export function substring1(s: string, a: number): string {
  return s.substring(a);
}
export function indexOf(s: string, p: string, f: number): number {
  return s.indexOf(p, f);
}
export function indexOf1(s: string, p: string): number {
  return s.indexOf(p);
}
export function lastIndexOf(s: string, p: string, f: number): number {
  return s.lastIndexOf(p, f);
}
export function lastIndexOf1(s: string, p: string): number {
  return s.lastIndexOf(p);
}
export function includes(s: string, p: string, f: number): boolean {
  return s.includes(p, f);
}
export function startsWith(s: string, p: string, f: number): boolean {
  return s.startsWith(p, f);
}
export function endsWith(s: string, p: string, f: number): boolean {
  return s.endsWith(p, f);
}
export function split(s: string, p: string): string[] {
  return s.split(p);
}
export function splitLim(s: string, p: string, n: number): string[] {
  return s.split(p, n);
}
export function trim(s: string): string {
  return s.trim();
}
export function trimStart(s: string): string {
  return s.trimStart();
}
export function trimEnd(s: string): string {
  return s.trimEnd();
}
export function repeat(s: string, n: number): string {
  return s.repeat(n);
}
export function padStart(s: string, n: number, f: string): string {
  return s.padStart(n, f);
}
export function padStart1(s: string, n: number): string {
  return s.padStart(n);
}
export function padEnd(s: string, n: number, f: string): string {
  return s.padEnd(n, f);
}
export function join(a: string[], sep: string): string {
  return a.join(sep);
}
export function joinNums(a: number[], sep: string): string {
  return a.join(sep);
}
export function replace(s: string, p: string, r: string): string {
  return s.replace(p, r);
}
export function replaceAll(s: string, p: string, r: string): string {
  return s.replaceAll(p, r);
}
export function fromCode(c: number): string {
  return String.fromCharCode(c);
}
export function fromCode2(a: number, b: number): string {
  return String.fromCharCode(a, b);
}
export function fromSpread(a: number[]): string {
  return String.fromCharCode(...a);
}
export function fromCodePoint(c: number): string {
  return String.fromCodePoint(c);
}
export function forOf(s: string): string[] {
  const out: string[] = [];
  for (const c of s) out.push(c);
  return out;
}
export function spread(s: string): string[] {
  return [...s];
}
export function arrayFrom(s: string): string[] {
  return Array.from(s);
}
export function parseI(s: string): number {
  return parseInt(s);
}
export function parseIR(s: string, r: number): number {
  return parseInt(s, r);
}
export function parseF(s: string): number {
  return parseFloat(s);
}
export function num(s: string): number {
  return Number(s);
}
export function truthy(s: string): boolean {
  return s ? true : false;
}
export function orElse(s: string, d: string): string {
  return s || d;
}
export function nullable(s: string | null): string {
  return s ?? "was null";
}
export function maybe(s: string | undefined): number {
  return s === undefined ? -1 : s.length;
}
export function sw(s: string): number {
  switch (s) {
    case "a":
      return 1;
    case "bb":
      return 2;
    case "é":
      return 3;
    case "":
      return 4;
    default:
      return 0;
  }
}
export function appendLoop(s: string, n: number): string {
  let r = "";
  for (let i = 0; i < n; i++) r += s;
  return r;
}
export function prependLoop(s: string, n: number): string {
  let r = "";
  for (let i = 0; i < n; i++) r = s + r;
  return r;
}
export function branch(s: string): string[] {
  const a = s + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = a + "x";
  const c = b + "y";
  const d = b + "z";
  const e = c + "1";
  const f = d + "2";
  const g = c + "3";
  return [
    a.slice(-3),
    b.slice(-3),
    c.slice(-3),
    d.slice(-3),
    e.slice(-3),
    f.slice(-3),
    g.slice(-3),
  ];
}
export function substrings(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 7) out.push(s.substring(i, i + 40));
  return out;
}
