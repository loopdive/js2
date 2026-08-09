// Why does W3 (tokenize + recursive-descent + heap AST) demote on linear?
import { compile } from "../src/index.ts";
import { readFileSync } from "node:fs";

const LIT = JSON.stringify("a0 + b0 * (c0 - d0 / 2) + fn0(x0, y0 * 3)");

const W3 = `class Node { kind: number; val: number; left: Node | null; right: Node | null;
  constructor(k: number, v: number, l: Node | null, r: Node | null) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
class St { i: number; constructor() { this.i = 0; } }
function parsePrimary(tk: number[], tv: number[], st: St): Node {
  if (st.i < tk.length && tk[st.i] === 40) { st.i = st.i + 1; const inner = parseAdd(tk, tv, st); if (st.i < tk.length && tk[st.i] === 41) st.i = st.i + 1; return inner; }
  const node = new Node(tk[st.i], tv[st.i], null, null);
  st.i = st.i + 1;
  return node;
}
function parseMul(tk: number[], tv: number[], st: St): Node {
  let left = parsePrimary(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 42 || tk[st.i] === 47)) { const op = tk[st.i]; st.i = st.i + 1; const right = parsePrimary(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function parseAdd(tk: number[], tv: number[], st: St): Node {
  let left = parseMul(tk, tv, st);
  while (st.i < tk.length && (tk[st.i] === 43 || tk[st.i] === 45)) { const op = tk[st.i]; st.i = st.i + 1; const right = parseMul(tk, tv, st); left = new Node(op, 0, left, right); }
  return left;
}
function checksum(x: Node | null): number { if (x === null) return 0; return x.kind + x.val + checksum(x.left) + checksum(x.right); }
export function bench(n: number): number {
  const s = ${LIT};
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    const tk: number[] = [];
    const tv: number[] = [];
    let pos = 0;
    while (pos < s.length) {
      const c = s.charCodeAt(pos);
      if (c === 32) { pos = pos + 1; continue; }
      if (c >= 48 && c <= 57) { let v = 0; while (pos < s.length) { const d = s.charCodeAt(pos); if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); pos = pos + 1; } else break; } tk.push(1); tv.push(v); }
      else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) { let h = 0; while (pos < s.length) { const d = s.charCodeAt(pos); if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) { h = (h * 31 + d) | 0; pos = pos + 1; } else break; } tk.push(2); tv.push(h & 1023); }
      else { pos = pos + 1; tk.push(c); tv.push(0); }
    }
    const st = new St();
    acc = checksum(parseAdd(tk, tv, st)) | 0;
  }
  return acc;
}`;

// Progressive reduction: which construct in `bench` demotes it?
const VARIANTS = {
  "full W3": W3,
  "no St / no parse (tokenize into arrays only)": W3.replace(
    "    const st = new St();\n    acc = checksum(parseAdd(tk, tv, st)) | 0;",
    "    acc = tk.length + tv.length;",
  ),
  "no array push (scan only)": W3.replace(/tk\.push\([^)]*\); tv\.push\([^)]*\);/g, "")
    .replace("    const st = new St();\n    acc = checksum(parseAdd(tk, tv, st)) | 0;", "    acc = pos;"),
  "tokenize into arrays, no |0 hash": W3.replace("h = (h * 31 + d) | 0;", "h = h + d;").replace(
    "    const st = new St();\n    acc = checksum(parseAdd(tk, tv, st)) | 0;",
    "    acc = tk.length;",
  ),
};

for (const [name, src] of Object.entries(VARIANTS)) {
  const r = await compile(src, { fileName: "w3.ts", skipSemanticDiagnostics: true, target: "linear" });
  console.log(`\n### ${name}: ${r.binary?.length ? "OK " + r.binary.length + "B" : "CE " + ((r.errors ?? [])[0]?.message ?? "")}`);
}
