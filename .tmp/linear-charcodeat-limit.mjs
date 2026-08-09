// Exactly which function bodies may contain `charCodeAt` on the linear backend?
import { compile } from "../src/index.ts";

const B = (body) => `function f(s: string, i: number): number { ${body} }
export function bench(n: number): number { return f("hello world", 1); }`;

const CASES = {
  "return s.charCodeAt(i)": B(`return s.charCodeAt(i);`),
  "const c = ...; return c": B(`const c = s.charCodeAt(i); return c;`),
  "let a=0; a=...; return a": B(`let a = 0; a = s.charCodeAt(i); return a;`),
  "if guard then return": B(`if (i < s.length) return s.charCodeAt(i); return 0;`),
  "two charCodeAt, no loop": B(`return s.charCodeAt(i) + s.charCodeAt(i + 1);`),
  "for loop, sum": B(`let a = 0; for (let k = 0; k < 3; k++) a = a + s.charCodeAt(k); return a;`),
  "while loop, sum": B(`let a = 0; let k = 0; while (k < 3) { a = a + s.charCodeAt(k); k = k + 1; } return a;`),
  "for loop, no charCodeAt inside": B(`let a = 0; for (let k = 0; k < 3; k++) a = a + k; return a + s.charCodeAt(i);`),
  "loop bound uses s.length only": B(`let a = 0; for (let k = 0; k < s.length; k++) a = a + k; return a;`),
  "do-while with charCodeAt": B(`let a = 0; let k = 0; do { a = a + s.charCodeAt(k); k = k + 1; } while (k < 3); return a;`),
  "if/else with charCodeAt in both": B(`if (i > 0) return s.charCodeAt(i); else return s.charCodeAt(0);`),
  "charCodeAt in caller's loop (callee simple)": `function ch(s: string, i: number): number { return s.charCodeAt(i); }
function f(s: string): number { let a = 0; for (let k = 0; k < s.length; k++) a = a + ch(s, k); return a; }
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
        } catch (e) {
          s = "INVALID";
        }
      }
    } catch {
      s = "THROW";
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(12)}`);
  }
  console.log(name.padEnd(44) + "| " + out.join("| "));
}
