// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 round 2 — a vec receiver enumerates as `[]` in `__for_in_keys`.
//
// `__for_in_keys`' per-level walk collects struct FIELD names and sidecar keys.
// A vec (compiled array / registered `arguments` object) has neither: its
// elements live in the array carrier and their attributes in the
// `_wasmPropDescs` sidecar table. So the walk answered `[]`.
//
// Single-module that never showed, because a same-module `for…in` is lowered
// in-wasm and never reaches this import. Across a #5225 linked boundary the
// receiver is an opaque externref in the READER, so the import is the only
// path — and propertyHelper's `isEnumerable` opens with exactly that `for…in`:
//
//   return stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name);
//
// With `stringCheck` false the `&&` short-circuits, so `verifyProperty`
// reported `N descriptor should be enumerable` — and the two own-property
// PREDICATES the 2026-09-17 round-1 note blamed were never reached at all
// (instrumented: neither the `__hasOwnProperty` import nor
// `_wasmStructHasOwn` fires; `__for_in_keys` fires once and returns `[]`).
//
// Measured 2026-09-17 on the 114-row #6482 descriptor bucket with the real
// runner (`tests/test262-chunk-dynamic.test.ts`, one chunk, path-filtered):
// linked 49/114 → 68/114 pass (+19, ZERO regressions), honest 105/114 → 105/114
// with zero rows changed.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482r2-"));
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

describe("#6482 r2 — a provider must enumerate a consumer vec's element indices", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  // The provider-side `for…in` that `isEnumerable` opens with. Reaches
  // `__for_in_keys` with a consumer-minted `arguments` vec.
  it("answers isEnumerable(arguments, index) in the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}function f(a, b, c) { assert.sameValue(isEnumerable(arguments, "0"), true, "ie"); }\nf(0, 1, 2);`,
      ),
    ).toBe("pass");
  }, 300_000);

  // The minimal body behind the 11 `language/arguments-object/mapped/*` rows.
  it("verifies a mapped arguments element descriptor from the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}function f(a, b, c) {\n` +
          `  Object.defineProperty(arguments, "0", { value: 10, writable: true, enumerable: true, configurable: true });\n` +
          `  verifyProperty(arguments, "0", { value: 10, writable: true, enumerable: true, configurable: true });\n` +
          `}\nf(0, 1, 2);`,
      ),
    ).toBe("pass");
  }, 300_000);

  // An untouched arguments element (no defineProperty at all) — the read-side
  // `_SC_ELEM_DEFAULT` synthesis has to agree with the new enumeration.
  it("verifies an untouched arguments element from the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}function f(a) { verifyProperty(arguments, "0", { value: 1, writable: true, enumerable: true, configurable: true }); }\nf(1);`,
      ),
    ).toBe("pass");
  }, 300_000);

  // `length` is non-enumerable on an arguments object (§10.4.4) and on an Array
  // (§23.1.4.1). The new index arm must not yield it.
  it("does not enumerate a vec's `length`", async () => {
    expect(
      await runLinked(
        `${HEADER}function f(a, b) {\n` +
          `  var seen = [];\n` +
          `  for (var k in arguments) seen.push(k);\n` +
          `  assert.sameValue(seen.join(","), "0,1", "arguments for-in keys");\n` +
          `}\nf(1, 2);`,
      ),
    ).toBe("pass");
  }, 300_000);
});
