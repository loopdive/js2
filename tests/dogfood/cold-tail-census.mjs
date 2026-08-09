// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3927) Deterministic allocation census for the hot/cold split.
//
// Compiles standalone acorn with `JS2WASM_ALLOC_CENSUS=1` (#3921), parses
// acorn's own dist bundle once inside wasm, then reads every
// `__alloc_count_*` exported global and multiplies by the per-instance size
// the census reported on stderr.
//
// The number this exists to report is the TAIL RATE — the share of
// `__fnctor_Node` instances that had to allocate a `$cold` tail. It is the
// lever the field ranking moves, and it is invisible in wall clock (see the
// issue's §6: this box cannot resolve anything under ~10 %).
//
// Deterministic: same K, same bytes, every run. Quote this, not wall clock.
//
// Usage: JS2WASM_FNCTOR_HOT_FIELDS=24 node tests/dogfood/cold-tail-census.mjs
//        (add `--opt 3` to measure the shipped optimisation level)
import { readFileSync } from "node:fs";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "./setup-acorn.mjs";

const optIdx = process.argv.indexOf("--opt");
const optimize = optIdx >= 0 ? Number(process.argv[optIdx + 1]) : 0;

function chunked(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 4096) out.push(JSON.stringify(s.slice(i, i + 4096)));
  return `[${out.join(",")}]`;
}

// The census writes its shape report to stderr; capture it by patching write.
const shapeLines = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const s = typeof chunk === "string" ? chunk : chunk.toString();
  if (s.startsWith("[alloc-census]")) {
    shapeLines.push(...s.split("\n").filter((l) => l.startsWith("[alloc-census]")));
    return true;
  }
  return realWrite(chunk, ...rest);
};

const { entryModulePath } = setupAcorn();
const source = readFileSync(entryModulePath, "utf-8");

const driver = `
var __chunks = ${chunked(source)};
var __input = "";
for (var __i = 0; __i < __chunks.length; __i++) { __input += __chunks[__i]; }
/** @returns {number} */
export function __census_run() {
  return parse(__input, { ecmaVersion: 2022, sourceType: "module" }).body.length;
}
`;

process.env.JS2WASM_ALLOC_CENSUS = "1";
const result = await compile(`${source}\n${driver}`, {
  fileName: "acorn.mjs",
  skipSemanticDiagnostics: true,
  target: "standalone",
  optimize,
});
process.stderr.write = realWrite;
if (!result.binary?.length) {
  console.error((result.errors ?? []).slice(0, 5));
  process.exit(1);
}

// `[alloc-census] __alloc_count_<name>_<idx>: struct, N fields (…), ~B B/instance`
const bytesByExport = new Map();
for (const line of shapeLines) {
  const m = line.match(/^\[alloc-census\] (\S+): (.*)$/);
  if (!m) continue;
  const b = m[2].match(/~(\d+) B\/instance/);
  bytesByExport.set(m[1], b ? Number(b[1]) : 0);
}

const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(result.binary), {});
const checksum = exports.__census_run();

let totalCount = 0;
let totalBytes = 0;
const rows = [];
for (const [name, value] of Object.entries(exports)) {
  if (!name.startsWith("__alloc_count_")) continue;
  const count = value.value;
  const per = bytesByExport.get(name) ?? 0;
  totalCount += count;
  totalBytes += count * per;
  rows.push({ name, count, per, bytes: count * per });
}
rows.sort((a, b) => b.bytes - a.bytes);

const node = rows.find((r) => r.name.includes("__fnctor_Node_") && !r.name.includes("__cold"));
const cold = rows.find((r) => r.name.includes("__fnctor_Node__cold"));
const K = process.env.JS2WASM_FNCTOR_HOT_FIELDS ?? "OFF";
const nodeBytes = (node?.bytes ?? 0) + (cold?.bytes ?? 0);
const rate = node && node.count > 0 ? (cold?.count ?? 0) / node.count : 0;

process.stdout.write(
  JSON.stringify({
    k: K,
    optimize,
    checksum,
    binaryBytes: result.binary.length,
    allocations: totalCount,
    structBytes: totalBytes,
    nodeCount: node?.count ?? 0,
    nodePerInstance: node?.per ?? 0,
    tailCount: cold?.count ?? 0,
    tailPerInstance: cold?.per ?? 0,
    tailRatePct: Number((rate * 100).toFixed(2)),
    nodeStreamBytes: nodeBytes,
    effectiveBytesPerNode: node && node.count > 0 ? Number((nodeBytes / node.count).toFixed(1)) : 0,
    top5: rows.slice(0, 5).map((r) => `${r.name}=${r.count}×${r.per}B`),
  }) + "\n",
);
