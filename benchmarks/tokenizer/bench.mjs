// Compile the compile-friendly tokenizer standalone and race it against acorn.tokenizer.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setupAcorn } from "../../tests/dogfood/setup-acorn.mjs";

const MATCHED = [
  "arrow-params.js",
  "control-flow.js",
  "destructuring.js",
  "generators-async.js",
  "loops.js",
  "members-calls.js",
  "new-target.js",
  "objects.js",
  "operators.js",
  "optional-nullish.js",
  "regex.js",
  "sequence-misc.js",
  "spread-rest.js",
];
const CORPUS = "tests/dogfood/corpus";
const BIN = ".tmp/acorn-cache/fast-tokenizer.wasm";
const tokSrc = readFileSync("benchmarks/tokenizer/fast-tokenizer.ts", "utf-8").replace(/^export /gm, "");

let binary;
if (existsSync(BIN) && !process.argv.includes("--recompile")) binary = readFileSync(BIN);
else {
  const { compile } = await import("../../src/index.ts");
  let src =
    tokSrc +
    "\nconst __types = new Int32Array(65536);\nconst __starts = new Int32Array(65536);\nconst __ends = new Int32Array(65536);\n";
  MATCHED.forEach((f, i) => {
    src += `const __src_${i} = ${JSON.stringify(readFileSync(join(CORPUS, f), "utf-8"))};
export function bench_${i}(n: i32): i32 { return benchTokenize(__src_${i}, n, __types, __starts, __ends); }\nexport function benchv_${i}(n: i32): i32 { return benchTokenizeValues(__src_${i}, n, __types, __starts, __ends); }\n`;
  });
  const t0 = performance.now();
  const r = await compile(src, {
    fileName: "tok.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 3,
  });
  console.log(
    `[tok] compiled in ${Math.round(performance.now() - t0)}ms, ${r.binary?.length ?? 0} bytes, errors=${(r.errors ?? []).length}`,
  );
  if (!r.binary?.length) {
    console.error((r.errors ?? []).slice(0, 5));
    process.exit(1);
  }
  binary = r.binary;
  writeFileSync(BIN, binary);
}
const mod = await WebAssembly.compile(binary);
console.log(
  "[tok] imports:",
  WebAssembly.Module.imports(mod).length === 0
    ? "ZERO"
    : WebAssembly.Module.imports(mod)
        .map((i) => i.module + "::" + i.name)
        .join(","),
);
const { exports: ex } = await WebAssembly.instantiate(mod, {});
const { entryModulePath } = setupAcorn();
const acorn = await import(pathToFileURL(entryModulePath));

console.log("\nfixture              bytes   wasm ms  wasm+val   node ms   ratio  ratio+val");
let totW = 0,
  totN = 0,
  totB = 0,
  totV = 0;
for (let i = 0; i < MATCHED.length; i++) {
  const text = readFileSync(join(CORPUS, MATCHED[i]), "utf-8");
  const f = ex[`bench_${i}`];
  const fv = ex[`benchv_${i}`];
  const check = f(1);
  // deep warm both
  f(3000);
  if (fv) fv(3000);
  for (let k = 0; k < 3000; k++) {
    let c = 0;
    for (const t of acorn.tokenizer(text, { ecmaVersion: 2023 })) c++;
  }
  let wb = 1e9,
    nb = 1e9,
    vb = 1e9;
  for (let r = 0; r < 20; r++) {
    let t = performance.now();
    f(500);
    wb = Math.min(wb, (performance.now() - t) / 500);
    if (fv) {
      t = performance.now();
      fv(500);
      vb = Math.min(vb, (performance.now() - t) / 500);
    }
    t = performance.now();
    for (let k = 0; k < 500; k++) {
      let c = 0;
      for (const tk of acorn.tokenizer(text, { ecmaVersion: 2023 })) c++;
    }
    nb = Math.min(nb, (performance.now() - t) / 500);
  }
  totW += wb;
  totN += nb;
  totB += text.length;
  totV += vb < 1e9 ? vb : wb;
  const mbps = (ms) => text.length / 1048576 / (ms / 1000);
  console.log(
    MATCHED[i].padEnd(20),
    String(text.length).padStart(5),
    wb.toFixed(4).padStart(9),
    (vb < 1e9 ? vb : NaN).toFixed(4).padStart(10),
    nb.toFixed(4).padStart(9),
    (wb / nb).toFixed(2).padStart(7) + "x",
    ((vb < 1e9 ? vb : wb) / nb).toFixed(2).padStart(8) + "x",
    check ? "" : " (empty!)",
  );
}
console.log(
  `\nTOTAL ${totB} bytes: wasm ${totW.toFixed(4)}ms | wasm+values ${totV.toFixed(4)}ms | node ${totN.toFixed(4)}ms`,
);
console.log(
  `  boundaries-only: ${(totW / totN).toFixed(2)}x of node   |   value-materializing (apples-to-apples): ${(totV / totN).toFixed(2)}x of node`,
);
console.log(
  `throughput: wasm ${(totB / 1048576 / (totW / 1000)).toFixed(1)} MB/s vs node ${(totB / 1048576 / (totN / 1000)).toFixed(1)} MB/s`,
);
