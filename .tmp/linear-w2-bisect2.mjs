// Bisect the size at which the linear lane's tokenizer answer diverges,
// then pinpoint the first charCodeAt index that reads wrong at that size.
import { compile } from "../src/index.ts";

function makeInput(nExpr) {
  const p = [];
  for (let i = 0; i < nExpr; i++) p.push(`a${i} + b${i} * (c${i} - d${i} / 2) + fn${i}(x${i}, y${i} * 3, (z${i} + 1))`);
  return p.join(" + ");
}

const mk = (lit) => `export function cca(i: number): number { const s = ${lit}; return s.charCodeAt(i); }
export function len(): number { const s = ${lit}; return s.length; }`;

async function inst(lit, target) {
  const r = await compile(mk(lit), { fileName: "b.ts", skipSemanticDiagnostics: true, target });
  if (!r.binary?.length) return null;
  return (await WebAssembly.instantiate(await WebAssembly.compile(r.binary), {})).exports;
}

// linear scan over prefix LENGTH of the nExpr=40 input to find the exact
// character index at which the linear lane starts reading the wrong byte.
const FULL = makeInput(40);
for (const chars of [909, 1200, 1500, 1800, 2000, 2100, 2200, 2300, 2397]) {
  const pre = FULL.slice(0, chars);
  const lit = JSON.stringify(pre);
  const lin = await inst(lit, "linear");
  if (!lin) {
    console.log(chars, "CE");
    continue;
  }
  let firstBad = -1;
  let nBad = 0;
  for (let i = 0; i < pre.length; i++) {
    if (lin.cca(i) !== pre.charCodeAt(i)) {
      if (firstBad < 0) firstBad = i;
      nBad++;
    }
  }
  console.log(
    `chars=${String(chars).padStart(5)} linear len=${lin.len()} (js ${pre.length})  badChars=${nBad}` +
      (firstBad >= 0 ? `  firstBadIdx=${firstBad} js='${pre[firstBad]}'(${pre.charCodeAt(firstBad)}) linear=${lin.cca(firstBad)}` : ""),
  );
}
