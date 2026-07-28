// Isolate the two axes that flipped charCodeAt support on the linear backend:
//   (1) loop bound: constant vs `s.length`
//   (2) function arity / whether an unused `i` param is present
import { compile } from "../src/index.ts";

const CASES = {
  "1 param, bound=3": `function f(s: string): number { let a = 0; for (let k = 0; k < 3; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world"); }`,
  "1 param, bound=s.length": `function f(s: string): number { let a = 0; for (let k = 0; k < s.length; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world"); }`,
  "2 params, bound=3": `function f(s: string, i: number): number { let a = 0; for (let k = 0; k < 3; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world", 1); }`,
  "2 params, bound=s.length": `function f(s: string, i: number): number { let a = 0; for (let k = 0; k < s.length; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world", 1); }`,
  "2 params, bound=len local": `function f(s: string, i: number): number { const L = s.length; let a = 0; for (let k = 0; k < L; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world", 1); }`,
  "1 param, bound=len local": `function f(s: string): number { const L = s.length; let a = 0; for (let k = 0; k < L; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world"); }`,
  "1 param, bound=n param": `function f(s: string, n: number): number { let a = 0; for (let k = 0; k < n; k++) a = a + s.charCodeAt(k); return a; }
export function bench(n: number): number { return f("hello world", 11); }`,
  "2 params, let a=0;a=cca;return a": `function f(s: string, i: number): number { let a = 0; a = s.charCodeAt(i); return a; }
export function bench(n: number): number { return f("hello world", 1); }`,
  "1 param, let a=0;a=cca;return a": `function f(s: string): number { let a = 0; a = s.charCodeAt(1); return a; }
export function bench(n: number): number { return f("hello world"); }`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) s = "CE";
      else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(3);
        } catch {
          s = "INVALID";
        }
      }
    } catch {
      s = "THROW";
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(12)}`);
  }
  console.log(name.padEnd(34) + "| " + out.join("| "));
}
