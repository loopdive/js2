// Fine-grained probe of the linear backend's string capability boundary.
// The parser/tokenizer workload needs: a string held in a field or param,
// `.length` on it, and `.charCodeAt(i)` in a loop. Find exactly what works.
import { compile } from "../src/index.ts";

const CASES = {
  "local const .length": `export function bench(n: number): number { const s = "hello world"; return s.length; }`,
  "module const .length": `const S = "hello world";
export function bench(n: number): number { return S.length; }`,
  "param .length": `function f(s: string): number { return s.length; }
export function bench(n: number): number { return f("hello world"); }`,
  "field .length": `class L { src: string; constructor(s: string) { this.src = s; } len(): number { return this.src.length; } }
export function bench(n: number): number { return new L("hello world").len(); }`,
  "local const charCodeAt(0)": `export function bench(n: number): number { const s = "hello world"; return s.charCodeAt(0); }`,
  "local let charCodeAt(0)": `export function bench(n: number): number { let s = "hello world"; return s.charCodeAt(0); }`,
  "local const charCodeAt(i) loop": `export function bench(n: number): number { const s = "hello world"; let a = 0; for (let i = 0; i < s.length; i++) a = a + s.charCodeAt(i); return a; }`,
  "local copied from param": `function f(s: string): number { const t = s; return t.charCodeAt(0); }
export function bench(n: number): number { return f("hello world"); }`,
  "local copied from field": `class L { src: string; constructor(s: string) { this.src = s; } first(): number { const t = this.src; return t.charCodeAt(0); } }
export function bench(n: number): number { return new L("hello world").first(); }`,
  "param charCodeAt": `function f(s: string): number { return s.charCodeAt(0); }
export function bench(n: number): number { return f("hello world"); }`,
  "module const charCodeAt": `const S = "hello world";
export function bench(n: number): number { return S.charCodeAt(0); }`,
  "field charCodeAt": `class L { src: string; constructor(s: string) { this.src = s; } first(): number { return this.src.charCodeAt(0); } }
export function bench(n: number): number { return new L("hello world").first(); }`,
  "local const s[i] index": `export function bench(n: number): number { const s = "hello world"; return s[0] === "h" ? 1 : 0; }`,
  "method on field object": `class I { v: number; constructor(v: number) { this.v = v; } two(): number { return this.v * 2; } }
class O { i: I; constructor(v: number) { this.i = new I(v); } t(): number { return this.i.two(); } }
export function bench(n: number): number { return new O(5).t(); }`,
  "method on local object": `class I { v: number; constructor(v: number) { this.v = v; } two(): number { return this.v * 2; } }
export function bench(n: number): number { const i = new I(5); return i.two(); }`,
  "method on array elem object": `class I { v: number; constructor(v: number) { this.v = v; } two(): number { return this.v * 2; } }
export function bench(n: number): number { const xs: I[] = []; xs.push(new I(5)); return xs[0].two(); }`,
  "this-method call (same class)": `class L { v: number; constructor(v: number) { this.v = v; } a(): number { return this.b() + 1; } b(): number { return this.v; } }
export function bench(n: number): number { return new L(5).a(); }`,
  "i32 alias local": `type i32 = number;
export function bench(n: number): number { let a: i32 = 0; for (let i: i32 = 0; i < 10; i++) a = a + i; return a; }`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) {
        const e = (r.errors ?? [])[0];
        s = "CE: " + (e?.messageText ?? e?.message ?? "?").toString().slice(0, 46);
      } else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(1);
        } catch (e) {
          s = "INVALID: " + String(e.message ?? e).slice(0, 60);
        }
      }
    } catch (e) {
      s = "THROW: " + String(e.message ?? e).slice(0, 46);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(52)}`);
  }
  console.log(name.padEnd(32) + "| " + out.join("| "));
}
