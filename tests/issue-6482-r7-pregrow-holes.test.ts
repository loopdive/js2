// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 round 7 — a `defineProperty` PRE-GROW creates holes, not zeros.
//
// `Object.defineProperty(arr, "<index>", desc)` on an index at or past the
// length makes codegen pre-grow the vec (`maybeEmitVecLengthGrowth`) BEFORE the
// runtime define runs. That grow used `array.new_default`, which ZERO-fills the
// tail it allocates — so the slot at the index held a legal-looking `0.0`/`null`
// by the time the runtime looked at it. `__vec_has_own_index` (#6482 r4) reads
// the RAW element to tell a hole from a present one, so it answered "own" for an
// index that did not exist a moment earlier, and `_vecDefineOwnProperty` treated
// the define as a REDEFINE (§10.1.6.3 keeps omitted attributes) instead of a
// FIRST definition (omitted attributes default FALSE).
//
// Measured, that mis-classification cost 10 rows of the §10.1.6.3
// first-definition matrix on the `Object/defineProperty/15.2.3.6-4-*` slice
// (`{201,203,216,218,238,241,246,248,251,538-6}`) — which is why the round-5
// element-default seeding could not ship until this landed. §10.4.2.1 already
// says a grow creates HOLES; round 4b applied exactly this rule to the
// `defineProperty(arr, "length", …)` site, and this is the same rule owed by
// the index site.
//
// TWO RESTRICTIONS ARE LOAD-BEARING, both measured rather than reasoned:
//
//   - the fill covers the EXTERNREF carrier too, not just f64. An EMPTY array
//     literal (`var arr = []`) has no element-type evidence and is minted on the
//     externref carrier, where a default slot reads back as `null` — which the
//     oracle does not recognise as a hole. f64-only left every one of those rows
//     failing.
//   - it runs only for a statically recognisable DATA descriptor. An accessor
//     define writes no element, so the marker would survive and the index would
//     read back ABSENT.
//
// These cases must run in the LINKED lane for the reason
// `tests/issue-6482-r3-sparse-vec-own-indices.test.ts` documents: a
// single-module `compile()` lowers the presence questions in-wasm and never
// reaches the host arms this protects.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482r7-"));
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

describe("#6482 r7 — a defineProperty pre-grow creates holes", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 900_000);

  // `15.2.3.6-4-201`'s body. The index did not exist, so the omitted `writable`
  // must default FALSE. With the zero-filled slot this read back `true`.
  it("treats a fresh index on an empty array as a FIRST definition", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [];\n` +
          `Object.defineProperty(arrObj, "0", { value: 1001, enumerable: true, configurable: false });\n` +
          `verifyProperty(arrObj, "0", { value: 1001, writable: false, enumerable: true, configurable: false });`,
      ),
    ).toBe("pass");
  }, 600_000);

  // The other half of the same rule, and the one an over-eager fill breaks: an
  // index that DOES exist keeps its attributes across an omitted-field redefine
  // (§10.1.6.3). `15.2.3.6-4-260`.
  it("treats an existing element as a REDEFINE", async () => {
    expect(
      await runLinked(
        // `15.2.3.6-4-260`'s exact body. The literal is `[undefined]`, not a
        // NUMBER literal: a number literal mints the f64 carrier, where
        // `isWritable`'s `"unlikelyValue"` store is separately lossy (the
        // round-6 residual, `15.2.3.7-6-a-247` / `15.2.3.6-4-258`) and the case
        // would fail for a reason that has nothing to do with this rule.
        `${HEADER}var arrObj = [undefined];\n` +
          `Object.defineProperty(arrObj, "0", { value: 100 });\n` +
          `verifyProperty(arrObj, "0", { value: 100, writable: true, enumerable: true, configurable: true });`,
      ),
    ).toBe("pass");
  }, 600_000);

  // The ACCESSOR restriction. `15.2.3.6-4-538-6` defines a getter/setter on a
  // fresh index of an `arguments` object and then redefines it with a value;
  // filling for the accessor define left a marker no value ever overwrote, and
  // the result read back non-configurable.
  it("does not mark a fresh index absent for an accessor define", async () => {
    expect(
      await runLinked(
        `${HEADER}var obj = (function() { return arguments; }());\n` +
          `obj.verifySetFunc = "data";\n` +
          `Object.defineProperty(obj, "0", {\n` +
          `  get: function() { return obj.verifySetFunc; },\n` +
          `  set: function(value) { obj.verifySetFunc = value; },\n` +
          `  enumerable: true, configurable: true });\n` +
          `Object.defineProperty(obj, "0", { value: 1001 });\n` +
          `assert.sameValue(obj[0], 1001, "obj[0]");\n` +
          `assert.sameValue(isConfigurable(obj, "0"), true, "isConfigurable");`,
      ),
    ).toBe("pass");
  }, 600_000);

  // A grown index must still be reachable — the fill must not make a real
  // element unreadable.
  it("keeps a grown index readable and own", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [7];\n` +
          `Object.defineProperty(arr, "3", { value: 9, writable: true, enumerable: true, configurable: true });\n` +
          `assert.sameValue(arr.length, 4, "length");\n` +
          `assert.sameValue(arr[3], 9, "arr[3]");\n` +
          `assert.sameValue(arr.hasOwnProperty(String(3)), true, 'hasOwnProperty("3")');\n` +
          `assert.sameValue(arr.hasOwnProperty(String(1)), false, 'hasOwnProperty("1")');`,
      ),
    ).toBe("pass");
  }, 600_000);
});
