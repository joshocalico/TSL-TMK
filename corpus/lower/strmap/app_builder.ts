// String builders, of all the shapes people write: += in a loop, prepending, an array and join, a CSV, a table.
export function append(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) s += "x";
  return s.length;
}
export function appendRead(n: number): number {
  let s = "";
  let t = 0;
  for (let i = 0; i < n; i++) {
    s += String.fromCharCode(97 + (i % 26));
    t += s.charCodeAt(i);
  }
  return t;
}
export function prepend(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s = String(i % 10) + s;
  return s.slice(0, 20);
}
export function viaJoin(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`item${i}`);
  return parts.join(",").slice(-30);
}
export function csv(rows: number, cols: number): string {
  let out = "";
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(String((r + 1) * (c + 1) * 0.5));
    out += `${cells.join(";")}\n`;
  }
  return out;
}
export function reverse(s: string): string {
  let r = "";
  for (const c of s) r = c + r;
  return r;
}
export function isPal(s: string): boolean {
  return s === reverse(s);
}
export function caesar(s: string, k: number): string {
  return s
    .split("")
    .map((c) => {
      const x = c.charCodeAt(0);
      if (x >= 97 && x <= 122) return String.fromCharCode(((x - 97 + k) % 26) + 97);
      return c;
    })
    .join("");
}
export function branchOff(n: number): string[] {
  let s = "0123456789".repeat(10);
  const kept: string[] = [];
  for (let i = 0; i < n; i++) {
    s += String(i);
    if (i % 5 === 0) kept.push(s);
    if (i % 7 === 0) kept.push(`${s}!`);
  }
  return kept.map((k) => k.slice(-6));
}
export function subs(s: string): number {
  const big = s.repeat(100);
  const pieces: string[] = [];
  for (let i = 0; i + 300 < big.length; i += 300) pieces.push(big.slice(i, i + 300));
  let t = 0;
  for (const p of pieces) t += p.indexOf(s.charAt(s.length - 1));
  return t;
}
export function padTable(): string {
  const rows = [
    ["name", "qty"],
    ["apple", "3"],
    ["kiwi", "12"],
  ];
  return rows.map((r) => `${r[0]!.padEnd(8)}|${r[1]!.padStart(4, "0")}`).join("\n");
}
