// W2 checksums diverged (linear 29675 vs node/gc 28117). Find the exact
// charCodeAt indices where the linear lane disagrees with JS semantics.
import { compile } from "../src/index.ts";

const INPUT = "a0 + b0 * (c0 - d0 / 2) + fn0(x0, y0 * 3, (z0 + 1))";
const LIT = JSON.stringify(INPUT);

const src = `export function bench(i: number): number { const s = ${LIT}; return s.charCodeAt(i); }
export function len(i: number): number { const s = ${LIT}; return s.length; }`;

const out = {};
for (const target of ["standalone", "linear"]) {
  const r = await compile(src, { fileName: "d.ts", skipSemanticDiagnostics: true, target });
  if (!r.binary?.length) {
    console.log(target, "CE", (r.errors ?? [])[0]?.message);
    continue;
  }
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {});
  out[target] = inst.exports;
}

console.log("js length:", INPUT.length, " gc:", out.standalone?.len(0), " linear:", out.linear?.len(0));
let bad = 0;
for (let i = 0; i < INPUT.length; i++) {
  const j = INPUT.charCodeAt(i);
  const g = out.standalone?.bench(i);
  const l = out.linear?.bench(i);
  if (g !== j || l !== j) {
    if (bad < 25) console.log(`i=${String(i).padStart(3)} ch=${JSON.stringify(INPUT[i])} js=${j} gc=${g} linear=${l}`);
    bad++;
  }
}
console.log("divergent indices:", bad, "/", INPUT.length);
// out-of-range behaviour (§22.1.3.3 => NaN)
for (const i of [-1, INPUT.length, INPUT.length + 5]) {
  console.log(`oob i=${i}: js=${INPUT.charCodeAt(i)} gc=${out.standalone?.bench(i)} linear=${out.linear?.bench(i)}`);
}
