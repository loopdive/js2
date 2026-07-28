// Reproduce the exact W2 checksum divergence and shrink it by input size.
import { compile } from "../src/index.ts";

function makeInput(nExpr) {
  const p = [];
  for (let i = 0; i < nExpr; i++) p.push(`a${i} + b${i} * (c${i} - d${i} / 2) + fn${i}(x${i}, y${i} * 3, (z${i} + 1))`);
  return p.join(" + ");
}
const W2_BODY = `
  let acc = 0;
  for (let rep = 0; rep < n; rep++) {
    let pos = 0;
    let count = 0;
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
    acc = count;
  }
  return acc;`;

for (const nExpr of [1, 2, 3, 4, 8, 16, 40]) {
  const INPUT = makeInput(nExpr);
  const LIT = JSON.stringify(INPUT);
  const ts = `export function bench(n: number): number {\n  const s = ${LIT};${W2_BODY}\n}`;
  const jsFn = new Function(`function bench(n) {\n  const s = ${LIT};${W2_BODY}\n}; return bench;`)();
  const row = { nExpr, chars: INPUT.length, node: jsFn(3) };
  for (const target of ["standalone", "linear"]) {
    const r = await compile(ts, { fileName: "w.ts", skipSemanticDiagnostics: true, target });
    if (!r.binary?.length) {
      row[target] = "CE";
      continue;
    }
    const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
    row[target] = inst.exports.bench(3);
  }
  const ok = row.node === row.standalone && row.node === row.linear;
  console.log(
    `nExpr=${String(nExpr).padStart(3)} chars=${String(row.chars).padStart(5)}  node=${row.node}  gc=${row.standalone}  linear=${row.linear}  ${ok ? "OK" : "*** DIFF (linear-node=" + (row.linear - row.node) + ")"}`,
  );
}
