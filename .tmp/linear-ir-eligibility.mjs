// Narrow WHY charCodeAt works in some linear functions and not others.
// Hypothesis: charCodeAt exists only in the opt-in linear-IR overlay
// (src/ir/backend/linear-integration.ts); functions the overlay rejects fall
// back to the direct linear backend, which has no charCodeAt arm at all
// (see the comment on addLinearIrStringRuntime in src/codegen-linear/runtime.ts).
import { compile } from "../src/index.ts";

const CASES = {
  "A for-loop, no helper call": `function scan(s: string): number { let a = 0; for (let i = 0; i < s.length; i++) a = a + s.charCodeAt(i); return a; }
export function bench(n: number): number { return scan("hello world"); }`,
  "B while-loop, no helper call": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { a = a + s.charCodeAt(p); p = p + 1; } return a; }
export function bench(n: number): number { return scan("hello world"); }`,
  "C while + const c binding": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); a = a + c; p = p + 1; } return a; }
export function bench(n: number): number { return scan("hello world"); }`,
  "D + calls a numeric helper": `function isD(c: number): boolean { return c >= 48 && c <= 57; }
function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (isD(c)) a = a + 1; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab12"); }`,
  "E + inlined predicate (no call)": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (c >= 48 && c <= 57) a = a + 1; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab12"); }`,
  "F + if/else-if chain": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (c >= 48 && c <= 57) a = a + 1; else if (c === 32) a = a + 2; else a = a + c; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab 12"); }`,
  "G + nested while": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { while (p < s.length && s.charCodeAt(p) === 32) p = p + 1; if (p >= s.length) break; a = a + s.charCodeAt(p); p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab 12"); }`,
  "H + break": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (c === 32) break; a = a + c; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab 12"); }`,
  "I + early return": `function scan(s: string): number { let a = 0; let p = 0; while (p < s.length) { const c = s.charCodeAt(p); if (c === 32) return a; a = a + c; p = p + 1; } return a; }
export function bench(n: number): number { return scan("ab 12"); }`,
  "J + local array push": `function scan(s: string): number { const out: number[] = []; let p = 0; while (p < s.length) { out.push(s.charCodeAt(p)); p = p + 1; } let a = 0; for (let i = 0; i < out.length; i++) a = a + out[i]; return a; }
export function bench(n: number): number { return scan("hello world"); }`,
  "K + new of a numeric class": `class St { pos: number; constructor() { this.pos = 0; } }
function scan(s: string): number { const st = new St(); let a = 0; while (st.pos < s.length) { a = a + s.charCodeAt(st.pos); st.pos = st.pos + 1; } return a; }
export function bench(n: number): number { return scan("hello world"); }`,
  "L exported directly (not via bench)": `export function scan(s: string): number { let a = 0; for (let i = 0; i < s.length; i++) a = a + s.charCodeAt(i); return a; }
export function bench(n: number): number { return 0; }`,
};

for (const [name, src] of Object.entries(CASES)) {
  const out = [];
  for (const target of ["standalone", "linear"]) {
    let s;
    try {
      const r = await compile(src, { fileName: "p.ts", skipSemanticDiagnostics: true, target });
      if (!r.binary?.length) {
        const e = (r.errors ?? [])[0];
        s = "CE: " + (e?.messageText ?? e?.message ?? "?").toString().slice(0, 44);
      } else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(3);
        } catch (e) {
          s = "INVALID: " + String(e.message ?? e).slice(0, 44);
        }
      }
    } catch (e) {
      s = "THROW: " + String(e.message ?? e).slice(0, 44);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(50)}`);
  }
  console.log(name.padEnd(36) + "| " + out.join("| "));
}
