#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Compile acorn to Wasm, write the `.wasm`, and diff its AST against node-acorn
// for ARBITRARY input files.
//
// The committed dogfood harnesses answer fixed questions:
//   `pnpm run dogfood:acorn`  — compile+validate+diff over 7 fixed fixtures in
//                               tests/dogfood/fixtures/inputs/, report only;
//   acorn-corpus.mjs          — the broad per-feature corpus + gap map.
// Neither takes a file path, and neither writes the binary to disk. This example
// is the third question: "does compiled-acorn parse MY file the same as
// node-acorn?" — point it at any .js/.mjs files and it answers per file.
//
//   node --max-old-space-size=4096 --import tsx \
//     examples/acorn-diff/acorn-diff.mjs src/foo.js src/bar.mjs
//
// Options:
//   --wasm <path>        also write the compiled binary (default: skip)
//   --ecma <n>           acorn ecmaVersion (default 2022)
//   --source-type <t>    "module" (default) or "script"
//   --show-quirks        include cosmetic marshalling quirks in the output
//   --max <n>            max divergences reported per file (default 5)
//   --json               machine-readable report on stdout
//
// The acorn source is the pinned, sha1-checked tarball from tests/dogfood — the
// SAME extracted module is both the compiled input and the node-acorn oracle, so
// there is zero version skew and every REAL divergence is a compiler bug.
//
// For iterating on INPUTS rather than the compiler, compile once with the CLI
// instead and load the artifacts from a plain Node script — see README.md.
//
// Pure tooling: fixes nothing, measures.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupAcorn } from "../../tests/dogfood/setup-acorn.mjs";
import { diffAst } from "../../tests/dogfood/ast-diff.mjs";

// A divergence is a cosmetic host-marshalling QUIRK — not a parser bug — iff it
// is the compiled-only `sourceFile` extra field, or a boolean that crossed the
// JS-host boundary as an i32 0/1 (`computed`/`static`/`optional`/…). Same rule
// as tests/dogfood/acorn-corpus.mjs; everything else corrupts tree structure.
function isQuirk(d) {
  if (d.reason === "extra-field" && /\.sourceFile$/.test(d.path)) return true;
  if (typeof d.expected === "boolean" && (d.actual === 0 || d.actual === 1)) return true;
  return false;
}

function parseArgs(argv) {
  const opts = {
    files: [],
    wasmOut: null,
    ecmaVersion: 2022,
    sourceType: "module",
    showQuirks: false,
    max: 5,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wasm") opts.wasmOut = argv[++i];
    else if (a === "--ecma") opts.ecmaVersion = Number(argv[++i]);
    else if (a === "--source-type") opts.sourceType = argv[++i];
    else if (a === "--show-quirks") opts.showQuirks = true;
    else if (a === "--max") opts.max = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

export async function acornDiff(opts) {
  const log = opts.json ? () => {} : (m) => console.log(m);
  const report = { acornVersion: null, compile: {}, files: [] };

  // --- compile the pinned acorn ONCE ---------------------------------------
  const { entryModulePath, version } = setupAcorn();
  report.acornVersion = version;
  log(`[acorn-diff] acorn@${version} (pinned tarball) -> wasm …`);

  const t0 = performance.now();
  // skipSemanticDiagnostics: acorn is plain pre-strict-mode JS, so full TS
  // semantic checking produces a wall of legitimate-but-irrelevant strict-null
  // diagnostics (verified against real `tsc --strict`, not a compiler bug).
  // All four dogfood acorn scripts do the same (#3717).
  const result = await compile(readFileSync(entryModulePath, "utf-8"), {
    fileName: "acorn.mjs",
    skipSemanticDiagnostics: true,
  });
  const compileMs = Math.round(performance.now() - t0);
  report.compile = {
    success: result.success,
    durationMs: compileMs,
    diagnostics: result.errors?.length ?? 0,
    binaryBytes: result.binary?.length ?? 0,
  };
  log(
    `[acorn-diff] compile success=${result.success} in ${compileMs}ms — ` +
      `${result.errors?.length ?? 0} diagnostics, ${result.binary?.length ?? 0} bytes`,
  );
  if (!result.binary?.length) throw new Error("no binary emitted — see result.errors");

  if (opts.wasmOut) {
    mkdirSync(dirname(resolve(opts.wasmOut)), { recursive: true });
    writeFileSync(opts.wasmOut, result.binary);
    report.compile.wasmOut = resolve(opts.wasmOut);
    log(`[acorn-diff] wrote ${opts.wasmOut}`);
    // NOTE: this is the JS-HOST binary — it has imports and needs `importObject`
    // to instantiate. `--standalone` would emit an import-free module, but its
    // `parse` cannot be fed from a JS host at all (the native-string carrier is
    // not constructible from outside), which is why the standalone lane uses
    // in-module canaries instead — see tests/dogfood/acorn-standalone-compile.mjs.
  }

  // --- instantiate + marshal ----------------------------------------------
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  // Wire the host runtime's exports hook so exports-backed capabilities
  // (closure wrapping, __sget_* struct reads, deferred start-window
  // defineProperties) work before anything is called.
  importObject.__setInstance?.(instance);
  // wrapExports is NOT optional: a raw `exports.parse` returns an opaque WasmGC
  // struct that diffs as an empty object. wrapExports (#1504) walks the node
  // graph back into plain JS (struct fields via __sget_*, sidecar props, vecs as
  // arrays) so the diff compares real tree shape.
  const exp = wrapExports(instance, { signatures: result.exportSignatures });
  if (typeof exp.parse !== "function") {
    throw new Error(
      `compiled module exposes no callable parse export (exports: ${Object.keys(exp).slice(0, 20).join(", ")})`,
    );
  }

  // Same extracted module as the oracle => zero parser-version skew.
  const oracle = await import(pathToFileURL(entryModulePath).href);

  // --- per-file diff -------------------------------------------------------
  const parseOptions = { ecmaVersion: opts.ecmaVersion, sourceType: opts.sourceType };
  let equalCount = 0;
  for (const file of opts.files) {
    const entry = { file };
    const src = readFileSync(file, "utf-8");

    let oracleAst;
    try {
      oracleAst = oracle.parse(src, parseOptions);
    } catch (e) {
      // node-acorn itself rejected the input: not a compiler finding.
      entry.status = "oracle-threw";
      entry.oracleError = e instanceof Error ? e.message : String(e);
      report.files.push(entry);
      log(`  ${file}: ORACLE THREW — ${entry.oracleError}`);
      continue;
    }

    let compiledAst;
    try {
      compiledAst = exp.parse(src, parseOptions);
    } catch (e) {
      entry.status = "compiled-threw";
      entry.compiledError = e instanceof Error ? e.message : String(e);
      report.files.push(entry);
      log(`  ${file}: COMPILED THREW — ${entry.compiledError}`);
      continue;
    }

    // Uncapped: a capped "equal" is worthless — the default cap of 8 hid real
    // divergences twice in prior sessions (see acorn-corpus.mjs header).
    const d = diffAst(oracleAst, compiledAst, { ignorePositions: true, maxDivergences: 100000 });
    const real = d.divergences.filter((x) => !isQuirk(x));
    const quirks = d.divergences.length - real.length;
    const reported = opts.showQuirks ? d.divergences : real;

    entry.status = real.length === 0 ? "equal" : "divergent";
    entry.realDivergences = real.length;
    entry.quirkDivergences = quirks;
    entry.sample = reported.slice(0, opts.max);
    report.files.push(entry);

    if (real.length === 0) {
      equalCount++;
      log(`  ${file}: EQUAL${quirks ? ` (${quirks} marshalling quirks ignored)` : ""}`);
    } else {
      log(`  ${file}: ${real.length} REAL divergences${quirks ? ` (+${quirks} quirks)` : ""}`);
      for (const x of entry.sample) {
        log(`      ${x.path}  ${x.reason}  expected=${JSON.stringify(x.expected)} actual=${JSON.stringify(x.actual)}`);
      }
      if (real.length > entry.sample.length) log(`      … ${real.length - entry.sample.length} more (raise --max)`);
    }
  }

  report.summary = {
    files: opts.files.length,
    equal: equalCount,
    divergent: report.files.filter((f) => f.status === "divergent").length,
    compiledThrew: report.files.filter((f) => f.status === "compiled-threw").length,
    oracleThrew: report.files.filter((f) => f.status === "oracle-threw").length,
  };
  log(`[acorn-diff] ${equalCount}/${opts.files.length} files match node-acorn`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.files.length === 0) {
    console.error("usage: acorn-diff.mjs [--wasm out.wasm] [--ecma 2022] [--source-type module|script]");
    console.error("                      [--show-quirks] [--max N] [--json] <file.js> …");
    process.exit(2);
  }
  const report = await acornDiff(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  // Non-zero exit on any real divergence so this is usable as a check.
  process.exit(report.summary.divergent + report.summary.compiledThrew > 0 ? 1 : 0);
}
