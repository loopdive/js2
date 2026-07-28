// Can the linear backend build a heap AST? (workload (b) of the head-to-head)
import { compile } from "../src/index.ts";

const CASES = {
  "class with number fields only": `class N { k: number; v: number; constructor(k: number, v: number) { this.k = k; this.v = v; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const x = new N(i, i * 2); a = a + x.v; } return a; }`,
  "assign null-able child field in ctor": `class N { v: number; left: N | null; constructor(v: number) { this.v = v; this.left = null; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const x = new N(i); a = a + x.v; } return a; }`,
  "assign child field AFTER ctor": `class N { v: number; left: N | null; constructor(v: number) { this.v = v; this.left = null; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const x = new N(i); const y = new N(i + 1); x.left = y; a = a + x.v; } return a; }`,
  "read child field": `class N { v: number; left: N | null; constructor(v: number) { this.v = v; this.left = null; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const x = new N(i); const y = new N(i + 1); x.left = y; const z = x.left; if (z !== null) a = a + z.v; } return a; }`,
  "child passed via ctor arg": `class N { v: number; left: N | null; constructor(v: number, l: N | null) { this.v = v; this.left = l; } }
export function bench(n: number): number { let a = 0; for (let i = 0; i < n; i++) { const y = new N(i + 1, null); const x = new N(i, y); a = a + x.v; } return a; }`,
  "array of objects, read field": `class N { v: number; constructor(v: number) { this.v = v; } }
export function bench(n: number): number { const xs: N[] = []; for (let i = 0; i < n; i++) xs.push(new N(i)); let a = 0; for (let j = 0; j < xs.length; j++) a = a + xs[j].v; return a; }`,
  "recursive fn over object graph": `class N { v: number; left: N | null; constructor(v: number, l: N | null) { this.v = v; this.left = l; } }
function total(x: N | null): number { if (x === null) return 0; return x.v + total(x.left); }
export function bench(n: number): number { let head: N | null = null; for (let i = 0; i < n; i++) head = new N(i, head); return total(head); }`,
  "number[] as node arena (3 i32/node)": `export function bench(n: number): number {
  const arena: number[] = [];
  let top = 0;
  for (let i = 0; i < n; i++) { arena.push(i); arena.push(i * 2); arena.push(-1); top = top + 3; }
  let a = 0;
  for (let p = 0; p < top; p = p + 3) a = a + arena[p + 1];
  return a;
}`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) s = "CE: " + ((r.errors ?? [])[0]?.message ?? "?").replace("Codegen error: ", "").slice(0, 40);
      else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(5);
        } catch {
          s = "INVALID";
        }
      }
    } catch (e) {
      s = "THROW " + String(e.message).slice(0, 34);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(46)}`);
  }
  console.log(name.padEnd(34) + "| " + out.join("| "));
}
