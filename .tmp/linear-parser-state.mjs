// Recursive-descent needs shared mutable cursor state across free functions.
// Which carrier does the linear backend accept?
import { compile } from "../src/index.ts";

const CASES = {
  "class instance param, mutated": `class St { i: number; constructor() { this.i = 0; } }
function step(st: St): number { st.i = st.i + 1; return st.i; }
export function bench(n: number): number { const st = new St(); let a = 0; for (let k = 0; k < n; k++) a = a + step(st); return a; }`,
  "mutable module-level global": `let CUR = 0;
function step(): number { CUR = CUR + 1; return CUR; }
export function bench(n: number): number { CUR = 0; let a = 0; for (let k = 0; k < n; k++) a = a + step(); return a; }`,
  "number[] param, read + write": `function step(xs: number[], i: number): number { xs[i] = xs[i] + 1; return xs[i]; }
export function bench(n: number): number { const xs: number[] = []; for (let k = 0; k < n; k++) xs.push(k); let a = 0; for (let k = 0; k < n; k++) a = a + step(xs, k); return a; }`,
  "recursive fn w/ class state + array": `class St { i: number; constructor() { this.i = 0; } }
class Node { kind: number; val: number; left: Node | null; right: Node | null; constructor(k: number, v: number, l: Node | null, r: Node | null) { this.kind = k; this.val = v; this.left = l; this.right = r; } }
function parseAtom(k: number[], v: number[], st: St): Node { const node = new Node(k[st.i], v[st.i], null, null); st.i = st.i + 1; return node; }
function parseAdd(k: number[], v: number[], st: St): Node {
  let left = parseAtom(k, v, st);
  while (st.i < k.length && k[st.i] === 3) { st.i = st.i + 1; const right = parseAtom(k, v, st); left = new Node(9, 0, left, right); }
  return left;
}
function sum(x: Node | null): number { if (x === null) return 0; return x.val + sum(x.left) + sum(x.right); }
export function bench(n: number): number {
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    const k: number[] = []; const v: number[] = [];
    for (let i = 0; i < 5; i++) { k.push(1); v.push(i); if (i < 4) { k.push(3); v.push(0); } }
    const st = new St();
    acc = sum(parseAdd(k, v, st));
  }
  return acc;
}`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) s = "CE: " + ((r.errors ?? [])[0]?.message ?? "?").replace("Codegen error: ", "").slice(0, 44);
      else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(4);
        } catch {
          s = "INVALID";
        }
      }
    } catch (e) {
      s = "THROW " + String(e.message).slice(0, 38);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(50)}`);
  }
  console.log(name.padEnd(32) + "| " + out.join("| "));
}
