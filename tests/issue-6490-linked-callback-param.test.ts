// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6490 — a CONSUMER callback invoked through a linked PROVIDER's callable
// parameter.
//
// In a linked graph the provider is its own wasm module. A callback the
// consumer passes in arrives as an `externref` whose closure struct belongs to
// the CONSUMER's type group, so the provider's guarded `ref.test`/`ref.cast` to
// its OWN wrapper root misses and yields `ref.null`. The callable-param
// dispatch then `struct.get`s that null and the module TRAPS with
// "dereferencing a null pointer" — un-catchable, so it takes the whole program
// down. Every call of `testTypedArray.js`'s `testWithTypedArrayConstructors`
// died this way (~1,340 corpus rows in the first full linked-lane run).
//
// The #1941 gate that suppressed the `__call_function` arm for ordinary
// function params ("pure local closures are always wrapped into the closure
// struct, so the arm would be dead code") is simply false for a provider: the
// value did not come from this module. `calleeIsLinkedProviderParam` re-admits
// the arm, gated on the linker-only `exportsConsumedByWasm` flag so every
// single-module compile stays byte-identical.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6490-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = `/*---\nincludes: [testTypedArray.js, compareArray.js]\n---*/\n`;

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

async function runLinked(source: string): Promise<string> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

describe("#6490 — consumer callbacks through a linked provider's callable param", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  it.each([
    [
      "the issue's minimal repro",
      `var n = 0; testWithTypedArrayConstructors(function () { n++; });\n` +
        `assert.sameValue(n > 0, true, "callback ran");`,
    ],
    [
      "the callback receives the constructor argument",
      `var seen = []; testWithTypedArrayConstructors(function (TA) { seen.push(TA.BYTES_PER_ELEMENT); });\n` +
        `assert.sameValue(seen.length > 0, true, "callback ran");\n` +
        `assert.sameValue(seen[0] > 0, true, "constructor arrived");`,
    ],
    [
      "an explicit constructor list still dispatches the consumer callback",
      // The helper iterates ctorArgFactories x ctors, so the call count is a
      // multiple of the list length, not the list length itself.
      `var bytes = []; testWithTypedArrayConstructors(function (TA) { bytes.push(TA.BYTES_PER_ELEMENT); },\n` +
        `  [Int8Array, Int32Array]);\n` +
        `assert.sameValue(bytes.length >= 2, true, "ran at least once per listed constructor");\n` +
        `assert.sameValue(bytes.length % 2, 0, "ran an equal number of times per constructor");\n` +
        `assert.sameValue(bytes[0], 1, "first listed constructor arrived");\n` +
        `assert.sameValue(bytes[1], 4, "second listed constructor arrived");`,
    ],
  ])(
    "does not trap: %s",
    async (_label, body) => {
      expect(await runLinked(HEADER + body)).toBe("pass");
    },
    300_000,
  );
});
