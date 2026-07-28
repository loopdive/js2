// The demotion reason is `ASCII encoding proof required for length input`.
// Linear strings are UTF-8 bytes; `.length` is a UTF-16 code-unit count, so it
// is only O(1)-lowerable when the receiver is PROVEN ascii. A string *param*
// carries no proof. A local string *literal* does. Verify that reading.
import { compile } from "../src/index.ts";

const CASES = {
  "literal local: len+cca": `export function bench(n: number): number { const s = "a1 + b2 * (c3 - d4)"; let a = 0; for (let i = 0; i < s.length; i++) a = a + s.charCodeAt(i); return a; }`,
  "param: len+cca": `function f(s: string): number { let a = 0; for (let i = 0; i < s.length; i++) a = a + s.charCodeAt(i); return a; }
export function bench(n: number): number { return f("a1 + b2 * (c3 - d4)"); }`,
  "literal module const: len+cca": `const S = "a1 + b2 * (c3 - d4)";
export function bench(n: number): number { let a = 0; for (let i = 0; i < S.length; i++) a = a + S.charCodeAt(i); return a; }`,
  "literal local, full tokenizer": `export function bench(n: number): number {
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    const s = "a1 + b2 * (c3 - d4 / 2) + fn5(x6, y7 * 3, (z8 + 1))";
    let pos = 0;
    let count = 0;
    while (pos < s.length) {
      let c = s.charCodeAt(pos);
      if (c === 32) { pos = pos + 1; continue; }
      if (c >= 48 && c <= 57) {
        let v = 0;
        while (pos < s.length) { const d = s.charCodeAt(pos); if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); pos = pos + 1; } else break; }
        count = count + 1;
      } else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) {
        while (pos < s.length) { const d = s.charCodeAt(pos); if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) pos = pos + 1; else break; }
        count = count + 2;
      } else { pos = pos + 1; count = count + c; }
    }
    acc = count;
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
      if (!r.binary?.length) s = "CE: " + ((r.errors ?? [])[0]?.message ?? "?").slice(0, 40);
      else {
        try {
          const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
          s = "v=" + inst.exports.bench(2) + " " + r.binary.length + "B";
        } catch (e) {
          s = "INVALID";
        }
      }
    } catch (e) {
      s = "THROW " + String(e.message).slice(0, 30);
    }
    out.push(`${target.padEnd(10)} ${s.padEnd(24)}`);
  }
  console.log(name.padEnd(32) + "| " + out.join("| "));
}
