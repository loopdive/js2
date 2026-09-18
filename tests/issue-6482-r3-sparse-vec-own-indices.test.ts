// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 round 3 — a HOLE is not an own property.
//
// Round 2 gave `__for_in_keys` and `_wasmStructHasOwn` a vec arm that answered
// own-ness from `idx < __vec_len(obj)`. That is sound for a registered
// `arguments` object — §10.4.4 maps exactly `0 .. length-1`, so an arguments
// vec is DENSE — and it is NOT sound for an ordinary array: `[0, , 2]` has a
// hole at index 1 that is in bounds and is not an own property.
//
// The host cannot tell the two apart on its own. Sparseness lives in the
// in-wasm #3251 overlay and `__vec_gopd` is not an export, so length is the
// only signal the host has. Answering from length alone reported holes as own
// and as enumerable, which cost 7 rows in the merge-group re-validation of
// PR #5964 — `Object/defineProperty/15.2.3.6-4-{159,160}`,
// `Object/defineProperties/15.2.3.7-6-a-{155,156,161,162}` and
// `Array/prototype/copyWithin/fill-holes`, each asserting
// `hasOwnProperty("1") === false` for a hole.
//
// The rule is now: an arguments vec yields every in-bounds index; any other vec
// yields only indices the HOST positively knows about (a `_wasmPropDescs` entry
// or a sidecar value — both put there by `Object.defineProperty` or a host
// write, so neither can be a hole). An in-bounds index the host has never seen
// is declined, because it may be one.
//
// THESE CASES MUST RUN IN THE LINKED LANE. In a single-module compile the same
// expressions are lowered in-wasm and never reach the host arms at all, so a
// plain `compile()` test asserts nothing about this fix (verified: it answers
// from the in-wasm path and disagrees with both the old and the new rule).
//
// Measured 2026-09-18, real runner, 1,862-row slice
// (`Object/defineProperty/**`, `Object/defineProperties/**`,
// `Array/prototype/copyWithin/**`, `expressions/await/**`,
// `optional-chaining/**`): linked 1451 → 1458, honest 1415 → 1422 — +7 in BOTH
// lanes, 0 regressed. The 114-row #6482 descriptor bucket holds at 98 linked,
// and the 818-row honest control is byte-identical to its pre-round-2 baseline.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482r3-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

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

const HEADER = `/*---\nincludes: [propertyHelper.js]\n---*/\n`;

describe("#6482 r3 — vec own-index answers must not invent holes", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  // The body of `Object/defineProperty/15.2.3.6-4-159.js`, one of the 7 rows
  // the over-broad round-2 rule lost.
  it("does not report a sparse array's hole as an own property", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [0, , 2];\n` +
          `Object.defineProperty(arrObj, "length", { value: 5 });\n` +
          `assert.sameValue(arrObj.length, 5, "length");\n` +
          `assert.sameValue(arrObj[0], 0, "arrObj[0]");\n` +
          `assert.sameValue(arrObj.hasOwnProperty("1"), false, 'hasOwnProperty("1")');\n` +
          `assert.sameValue(arrObj[2], 2, "arrObj[2]");\n` +
          `assert.sameValue(arrObj.hasOwnProperty("4"), false, 'hasOwnProperty("4")');`,
      ),
    ).toBe("pass");
  }, 300_000);

  // A present element of that same sparse array is still own — the fix must not
  // answer "no" to everything.
  it("still reports a present element of a sparse array as own", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [0, , 2];\nassert.sameValue(arrObj.hasOwnProperty("2"), true, 'hasOwnProperty("2")');`,
      ),
    ).toBe("pass");
  }, 300_000);

  // `15.2.3.6-4-201`: an index the HOST defined is unambiguous, so it must still
  // enumerate. Narrowing to arguments-only alone lost this one (measured: −2).
  it("enumerates an index the host defined, on an otherwise empty array", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [];\n` +
          `Object.defineProperty(arrObj, "0", { value: 1001, enumerable: true, configurable: false });\n` +
          `verifyProperty(arrObj, "0", { value: 1001, writable: false, enumerable: true, configurable: false });`,
      ),
    ).toBe("pass");
  }, 300_000);

  // The round-2 gain that must survive: an arguments vec is dense, so every
  // in-bounds index is own and enumerable.
  it("keeps an arguments object dense", async () => {
    expect(
      await runLinked(
        `${HEADER}function f(a, b, c) {\n` +
          `  assert.sameValue(isEnumerable(arguments, "1"), true, "isEnumerable");\n` +
          `  verifyProperty(arguments, "1", { value: 8, writable: true, enumerable: true, configurable: true });\n` +
          `}\nf(7, 8, 9);`,
      ),
    ).toBe("pass");
  }, 300_000);
});
