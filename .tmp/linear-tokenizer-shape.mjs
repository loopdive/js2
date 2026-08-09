// Can the linear backend compile a tokenizer shape at all?
// The class-with-`src`-field shape from .tmp/tokenize-only.mjs is blocked
// (`this.src.charCodeAt(...)` => CE). Probe the restructured, param-threaded
// shape: source string as a function PARAMETER, scanner state in locals.
import { compile } from "../src/index.ts";

const CASES = {
  "param threaded to helper": `function isDigit(c: number): boolean { return c >= 48 && c <= 57; }
function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (isDigit(c)) a = a + 1; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab12cd34"); }`,
  "string param re-passed": `function inner(s: string, i: number): number { return s.charCodeAt(i); }
function outer(s: string): number { let a = 0; for (let i = 0; i < s.length; i++) a = a + inner(s, i); return a; }
export function bench(n: number): number { return outer("hello world"); }`,
  "string in numeric-state class": `class St { pos: number; kind: number; val: number; constructor() { this.pos = 0; this.kind = 0; this.val = 0; } }
function next(s: string, st: St): void {
  while (st.pos < s.length && s.charCodeAt(st.pos) === 32) st.pos = st.pos + 1;
  if (st.pos >= s.length) { st.kind = 0; return; }
  const c = s.charCodeAt(st.pos);
  if (c >= 48 && c <= 57) { let v = 0; while (st.pos < s.length && s.charCodeAt(st.pos) >= 48 && s.charCodeAt(st.pos) <= 57) { v = v * 10 + (s.charCodeAt(st.pos) - 48); st.pos = st.pos + 1; } st.kind = 1; st.val = v; return; }
  st.pos = st.pos + 1; st.kind = c; st.val = 0;
}
export function bench(n: number): number { const st = new St(); let a = 0; next("12 + 34", st); while (st.kind !== 0) { a = a + st.kind; next("12 + 34", st); } return a; }`,
  "string param + local state, full loop": `function tok(s: string): number {
  let pos = 0; let acc = 0;
  while (pos < s.length) {
    let c = s.charCodeAt(pos);
    while (pos < s.length && c === 32) { pos = pos + 1; if (pos < s.length) c = s.charCodeAt(pos); }
    if (pos >= s.length) break;
    if (c >= 48 && c <= 57) { let v = 0; while (pos < s.length && s.charCodeAt(pos) >= 48 && s.charCodeAt(pos) <= 57) { v = v * 10 + (s.charCodeAt(pos) - 48); pos = pos + 1; } acc = acc + 1; }
    else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) { while (pos < s.length) { const d = s.charCodeAt(pos); if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) pos = pos + 1; else break; } acc = acc + 2; }
    else { pos = pos + 1; acc = acc + c; }
  }
  return acc;
}
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) a = tok("a1 + b2 * (c3 - d4 / 2)"); return a; }`,
  "AST node alloc: fields + child refs": `class Node { kind: number; val: number; left: Node | null; right: Node | null; constructor(k: number, v: number) { this.kind = k; this.val = v; this.left = null; this.right = null; } }
function sum(nd: Node | null): number { if (nd === null) return 0; return nd.val + sum(nd.left) + sum(nd.right); }
export function bench(n: number): number { let acc = 0; for (let i = 0; i < n; i++) { const root = new Node(1, i); root.left = new Node(2, i + 1); root.right = new Node(3, i + 2); root.left.left = new Node(4, i + 3); acc = sum(root); } return acc; }`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) {
        const e = (r.errors ?? [])[0];
        s = "CE: " + (e?.messageText ?? e?.message ?? "?").toString().slice(0, 50);
      } else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(3);
        } catch (e) {
          s = "INVALID: " + String(e.message ?? e).slice(0, 50);
        }
      }
    } catch (e) {
      s = "THROW: " + String(e.message ?? e).slice(0, 50);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(56)}`);
  }
  console.log(name.padEnd(38) + "| " + out.join("| "));
}
