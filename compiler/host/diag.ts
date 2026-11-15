// Diagnostics with stable codes (SPEC 3.6) and exact positions (SPEC 8.1).
import ts from "typescript";
import { repoRelative } from "./program.ts";

export interface Diag {
  code: string;
  file: string;
  line: number;
  col: number;
  msg: string;
}

export function formatDiag(d: Diag): string {
  return `${d.file}:${d.line}:${d.col}: ${d.code}: ${d.msg}`;
}

export class DiagSink {
  list: Diag[] = [];
  seen = new Set<string>();
  file: string;
  muted = 0;
  constructor(file: string) {
    this.file = file;
  }
  at(sf: ts.SourceFile, node: ts.Node, code: string, msg: string): void {
    if (this.muted > 0) return;
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const file = repoRelative(sf.fileName);
    const key = `${code}:${file}:${pos.line}:${pos.character}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ code, file, line: pos.line + 1, col: pos.character + 1, msg });
  }
  add(d: Diag): void {
    const key = `${d.code}:${d.file}:${d.line - 1}:${d.col - 1}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(d);
  }
  sorted(): Diag[] {
    return [...this.list].sort((a, b) => a.line - b.line || a.col - b.col);
  }
}
