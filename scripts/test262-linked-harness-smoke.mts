// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 2/3 — linked-harness smoke.
//
// Compiles the Test262 harness prefix ONCE per include-set as a separately
// linked provider module (the #2527 / Temporal-provider mechanism), compiles
// each test body against it, instantiates the pair, and prints the verdict and
// compile time next to the honest single-module assembly of the same test.
//
// Slice 3 moved the provider/prelude/body-compile logic OUT of this script and
// into `src/test262-harness-provider.ts`, so that the runner lane
// (`scripts/test262-worker.mjs`) and this measurement harness provably drive
// the same code. What remains here is measurement.
//
// This is a MEASUREMENT harness, not a runner lane: the "honest" column here
// instantiates with a plain import object (no runner sandbox, no negative-test
// or async handling), so only the body-compile timings and the linked/honest
// verdict AGREEMENT are meaningful. See the slice-2/3 notes in
// plan/issues/3451-linked-harness-wasm-separate-compilation.md for what it
// found.
//
//   pnpm run build:compiler-bundle && pnpm run build:runtime-bundle
//   node --import tsx scripts/test262-linked-harness-smoke.mts test262/test/built-ins/Array/prototype/map 12
//   JS2WASM_LINKED_SMOKE_CACHE=.tmp/linked-smoke   # provider project dir (default)

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompileResult } from "../src/index.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "./compiler-bundle.mjs";
import { compile } from "./compiler-bundle.mjs";
import * as runtimeBundle from "./runtime-bundle.mjs";
import { instantiateTest262Module } from "./test262-import-object.mjs";
import { assembleLinkedHarness } from "../tests/test262-original-harness.js";
import { parseMeta } from "../tests/test262-runner.js";

const CACHE = resolve(process.env.JS2WASM_LINKED_SMOKE_CACHE ?? ".tmp/linked-smoke");

const bodyOptions = {
  allowJs: true,
  fileName: "test.js",
  sourceMap: true,
  sourceMapUrl: "test.wasm.map",
  emitWat: false,
  skipSemanticDiagnostics: true,
  // Mirrors the worker's original-harness lane: an `import` must not make the
  // sloppy variant strict.
  inferModuleStrictArguments: false,
};

async function runVerdict(result: CompileResult): Promise<string> {
  if (!result.success) {
    const errors = (result.errors ?? [])
      .slice(0, 2)
      .map((e) => e.message)
      .join("; ");
    return `compile_error: ${errors.slice(0, 120)}`;
  }
  const importObj = runtimeBundle.buildImports(result.imports, { console }, result.stringPool);
  try {
    await instantiateTest262Module(result.binary, importObj, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime: runtimeBundle,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error).slice(0, 100)}`;
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node --import tsx scripts/test262-linked-harness-smoke.mts <test262 dir> [count]");
    process.exit(2);
  }
  const count = Number(process.argv[3] ?? 12);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".js") && !f.endsWith("_FIXTURE.js"))
    .slice(0, count);
  const providers = new Map<string, HarnessProvider>();
  let agree = 0;
  let compared = 0;
  for (const f of files) {
    const source = readFileSync(join(dir, f), "utf8");
    const assembly = assembleLinkedHarness(source, parseMeta(source));
    if (assembly.raw) {
      console.log(`${f.padEnd(48)} raw — skipped`);
      continue;
    }
    const label = assembly.harnessParts.map((p) => p.name).join("+");
    let provider: HarnessProvider;
    try {
      provider = await buildHarnessProvider({
        harnessPrefix: assembly.harnessPrefix,
        cacheDir: CACHE,
        compileOptions: bodyOptions,
      });
      providers.set(label, provider);
    } catch (error) {
      console.log(`${f.padEnd(48)} PROVIDER FAIL ${(error as Error).message}`);
      continue;
    }
    let started = performance.now();
    const honest = await compile(assembly.harnessPrefix + assembly.primary.bodySource, bodyOptions);
    const honestMs = performance.now() - started;
    const honestVerdict = await runVerdict(honest);
    started = performance.now();
    const linked = await compileHarnessLinkedBody(provider, assembly.primary.body, {
      ...bodyOptions,
      strict: assembly.primary.strict,
    });
    const linkedMs = performance.now() - started;
    const linkedVerdict = await runVerdict(linked);
    compared++;
    if (honestVerdict.split(":")[0] === linkedVerdict.split(":")[0]) agree++;
    console.log(
      `${f.padEnd(48)} honest ${honestMs.toFixed(0).padStart(5)}ms ${honestVerdict.slice(0, 40).padEnd(40)} | ` +
        `linked ${linkedMs.toFixed(0).padStart(5)}ms ${linkedVerdict}  [uses ${linked.harnessPrelude.names.join(",")}]`,
    );
  }
  for (const [label, p] of providers) {
    console.log(
      `provider ${label}: build ${p.buildMs.toFixed(0)} ms, ${p.artifact.binary.length} bytes, ` +
        `${p.getters.size}/${p.names.length} getter boundaries`,
    );
  }
  console.log(`verdict agreement (status only): ${agree}/${compared}`);
}

await main();
