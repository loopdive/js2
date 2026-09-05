#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Compile the pinned acorn tarball to Wasm for the playground's AST explorer.
//
// The explorer parses the user's source with acorn ITSELF COMPILED BY js2wasm —
// not with a JS copy of acorn — so the panel is a live demonstration that the
// compiler handles a real 230 KB parser graph, not just snippets.
//
// Emits three files into website/public/acorn/:
//   acorn.wasm           the compiled module (JS-host/gc target: it has imports)
//   acorn.manifest.json  the adapter manifest — the import plan AND the export
//                        metadata `wrapExports` needs to marshal acorn's AST
//                        back into plain JS objects. Shipped as JSON rather
//                        than as the generated `.imports.js` helper because the
//                        playground already has the js2wasm runtime loaded and
//                        the helper's `from "js2wasm"` specifier does not
//                        resolve from a statically-served file.
//   meta.json            provenance: acorn version, byte sizes, compile time.
//
// The artifacts are COMMITTED. Compiling acorn needs a multi-GB heap and
// minutes of CPU — too much for every `vite build`, and far too much for the
// browser. Refresh them deliberately:
//
//   node --max-old-space-size=6144 scripts/build-acorn-wasm.mjs
//
// `--check` re-compiles and reports whether the committed artifact is stale
// without writing anything.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../src/index.ts";
import { setupAcorn } from "../tests/dogfood/setup-acorn.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "website", "public", "acorn");

const CHECK_ONLY = process.argv.includes("--check");

const { entryModulePath, version } = setupAcorn();
const source = readFileSync(entryModulePath, "utf-8");

console.log(`[acorn-wasm] compiling acorn@${version} (${source.length} bytes of JS) …`);

const t0 = performance.now();
const result = await compile(source, {
  fileName: "acorn.mjs",
  // acorn is plain pre-strict-mode JS; full semantic checking reports a wall of
  // legitimate-but-irrelevant diagnostics that abort the compile even though
  // codegen succeeds. Same setting every acorn dogfood harness uses (#3717).
  skipSemanticDiagnostics: true,
  // Ship the optimized binary — this is a download in every playground session
  // that opens the AST tab.
  optimize: 3,
});
const compileMs = Math.round(performance.now() - t0);

if (!result.success || !result.binary?.length) {
  console.error(`[acorn-wasm] compile FAILED after ${compileMs}ms`);
  for (const e of (result.errors ?? []).slice(0, 20)) {
    console.error(`  ${e.line}:${e.column} ${e.message}`);
  }
  process.exit(1);
}

// `success` means codegen finished, not that the bytes form a module. Refuse to
// publish an artifact the browser will reject at instantiation.
const module = await WebAssembly.compile(result.binary);

// The explorer calls exactly one export. A binary that validates but does not
// expose it is useless to the panel, and the failure would only show up in the
// browser.
const exportNames = WebAssembly.Module.exports(module).map((e) => e.name);
if (!exportNames.includes("parse")) {
  console.error(`[acorn-wasm] the compiled module exports no \`parse\` (has: ${exportNames.slice(0, 20).join(", ")})`);
  process.exit(1);
}

const manifest = result.adapterManifest;
if (!manifest) {
  console.error("[acorn-wasm] compile produced no adapter manifest — the explorer cannot build the import object");
  process.exit(1);
}
// Note: `exportSignatures` is legitimately EMPTY for acorn. Its exports are
// untyped JS, so no param or return gets a classified boundary — `wrapExports`
// then falls back to its default copy marshalling, which is what walks the AST
// node graph back into plain JS. An empty map here is not a defect; only a
// missing manifest is.

const meta = {
  acornVersion: version,
  wasmBytes: result.binary.length,
  sourceBytes: source.length,
  compileMs,
  generatedAt: new Date().toISOString(),
};

const wasmPath = join(OUT_DIR, "acorn.wasm");
const manifestPath = join(OUT_DIR, "acorn.manifest.json");
const metaPath = join(OUT_DIR, "meta.json");

console.log(
  `[acorn-wasm] compiled in ${(compileMs / 1000).toFixed(1)}s — ` +
    `${result.binary.length} bytes, ${result.errors?.length ?? 0} diagnostics`,
);

if (CHECK_ONLY) {
  // Compare the BINARY only. meta.json carries a timestamp, so it always
  // differs; the manifest is derived from the same compile as the binary.
  const stale = !existsSync(wasmPath) || Buffer.compare(readFileSync(wasmPath), Buffer.from(result.binary)) !== 0;
  console.log(
    stale ? "[acorn-wasm] STALE — committed artifact differs from a fresh compile" : "[acorn-wasm] up to date",
  );
  process.exit(stale ? 1 : 0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(wasmPath, result.binary);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

console.log(`[acorn-wasm] wrote ${wasmPath}`);
console.log(`[acorn-wasm] wrote ${manifestPath}`);
console.log(`[acorn-wasm] wrote ${metaPath}`);
