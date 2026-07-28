// Shrink the W2 divergence: run the exact tokenizer body over growing prefixes
// of the input literal until linear disagrees with node/gc.
import { compile } from "../src/index.ts";

const FULL = "a0 + b0 * (c0 - d0 / 2) + fn0(x0, y0 * 3, (z0 + 1)) + a1 + b1 * (c1 - d1 / 2)";

const BODY = (lit) => `
  const s = ${lit};
  let count = 0;
  let pos = 0;
  while (pos < s.length) {
    const c = s.charCodeAt(pos);
    if (c === 32) { pos = pos + 1; continue; }
    if (c >= 48 && c <= 57) {
      let v = 0;
      while (pos < s.length) { const d = s.charCodeAt(pos); if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); pos = pos + 1; } else break; }
      count = count + 1 + v;
    } else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95) {
      while (pos < s.length) { const d = s.charCodeAt(pos); if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 95) pos = pos + 1; else break; }
      count = count + 2;
    } else { pos = pos + 1; count = count + c; }
  }
  return count;`;

for (let n = 1; n <= FULL.length; n++) {
  const pre = FULL.slice(0, n);
  const lit = JSON.stringify(pre);
  const ref = new Function(`${BODY(lit)}`)();
  const vals = {};
  for (const target of ["standalone", "linear"]) {
    const r = await compile(`export function bench(n: number): number {${BODY(lit)}\n}`, {
      fileName: "d.ts",
      skipSemanticDiagnostics: true,
      target,
    });
    if (!r.binary?.length) {
      vals[target] = "CE";
      continue;
    }
    const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
    vals[target] = inst.exports.bench(1);
  }
  if (vals.standalone !== ref || vals.linear !== ref) {
    console.log(`FIRST DIVERGENCE at prefix len ${n}: ${JSON.stringify(pre)}`);
    console.log(`  js=${ref} gc=${vals.standalone} linear=${vals.linear}`);
    break;
  }
  if (n % 10 === 0) console.log(`len ${n} ok (=${ref})`);
}
