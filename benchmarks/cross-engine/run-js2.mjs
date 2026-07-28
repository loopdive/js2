// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3684) Cross-engine axis benchmark — js2 standalone leg.
// Compiles the SAME `axes-core.js` body with `--target standalone` (zero
// imports) and times each exported bench from the host. The loops are long
// enough that the single call-boundary crossing is noise. See README.md.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { compile } from "../../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(HERE, "axes-core.js"), "utf-8");

let subject = "";
for (let i = 0; i < 800; i++) subject += `var x${i} = function(a,b){ return a+b*${i} };\n`;
// Chunked: one 35 KB string literal overflows the compiler's expression recursion.
const chunks = [];
for (let i = 0; i < subject.length; i += 4096) chunks.push(subject.slice(i, i + 4096));

const source = `${core}
const __parts = [${chunks.map((c) => JSON.stringify(c)).join(",\n")}];
const SRC = __parts.join("");
export function bench_numeric() { return benchNumeric(); }
export function bench_prop() { return benchProp(); }
export function bench_method() { return benchMethod(); }
export function bench_string() { return benchString(SRC); }
export function bench_alloc() { return benchAlloc(); }
export function bench_tokenizer() { return benchTokenizer(SRC); }
`;

const t0 = performance.now();
const result = await compile(source, { fileName: "axes.mjs", skipSemanticDiagnostics: true, target: "standalone" });
console.log(
  `js2 compile: ${Math.round(performance.now() - t0)}ms, ok=${result.success}, bytes=${result.binary?.length ?? 0}`,
);
if (!result.binary?.length) {
  for (const e of (result.errors ?? []).slice(0, 6)) console.error("ERR:", e.messageText ?? e.message ?? e);
  process.exit(1);
}

const module = await WebAssembly.compile(result.binary);
const importCount = WebAssembly.Module.imports(module).length;
if (importCount !== 0) console.error(`WARNING: expected 0 imports, got ${importCount}`);
const { exports } = await WebAssembly.instantiate(module, {});

console.log("\n=== js2 standalone ===");
for (const name of ["numeric", "prop", "method", "string", "alloc", "tokenizer"]) {
  const fn = exports[`bench_${name}`];
  if (typeof fn !== "function") {
    console.log(`${name} MISSING EXPORT`);
    continue;
  }
  let chk;
  try {
    chk = fn(); // warmup
  } catch (e) {
    console.log(`${name} THREW/TRAP: ${e?.message ?? e}`);
    continue;
  }
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const s = performance.now();
    fn();
    const dt = performance.now() - s;
    if (dt < best) best = dt;
  }
  console.log(`${name} ms=${best.toFixed(4)} chk=${chk}`);
}
