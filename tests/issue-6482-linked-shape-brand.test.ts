// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 — cross-MODULE shape-type collision in the linked test262 harness.
//
// WasmGC canonicalizes two struct types with the same field layout to ONE
// runtime type, and that does not stop at the module edge. The harness
// provider declares `__anon_{label,restore}` (propertyHelper's `options`
// shape); a test body declares `__anon_{enumerable,configurable}` (a
// `prop-desc.js` descriptor literal). Both are
// `(struct (field externref) (field externref))`, i.e. the SAME type — so the
// provider's `__struct_field_names` `ref.test` ladder HITS the consumer's
// struct and answers `"label,restore"`. `verifyProperty`'s own-name scan then
// reports `Invalid descriptor field: label`.
//
// The #5225 host decoder registry cannot repair this: it prefers the local
// module precisely because the local module answered a non-empty name list,
// and here that answer is a canonical-collision false positive no host-side
// probe can distinguish from a real hit. The fix is type-level — each side of
// a linked project anchors the #2853 brand chain on a different pre-registered
// runtime type, so no provider shape can ever canonicalize with a consumer
// shape.
//
// Measured 2026-09-17 on the 114-row #6482 descriptor bucket with the real
// runner (`tests/test262-chunk-dynamic.test.ts`, one chunk, path-filtered):
// linked 0/114 → 44/114 pass, honest 105/114 → 105/114 with ZERO rows changed.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482-"));
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

describe("#6482 — a provider must not decode a consumer shape as its own", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  // The minimal body behind the 35 `Invalid descriptor field: label` rows: a
  // two-field descriptor literal minted in the consumer, whose own-property
  // NAMES are read in the provider (`__getOwnPropertyNames(desc)`).
  it("reads a consumer two-field descriptor literal's own names in the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}var o = {};\n` +
          `Object.defineProperty(o, "p", { get: function () { return 1; }, enumerable: false, configurable: true });\n` +
          `verifyProperty(o, "p", { enumerable: false, configurable: true });`,
      ),
    ).toBe("pass");
  }, 300_000);

  // A four-field data descriptor does not collide with the harness `options`
  // shape, so it passed before the fix too — it pins that the brand did not
  // break the case that already worked.
  it("keeps a consumer four-field data descriptor working", async () => {
    expect(
      await runLinked(
        `${HEADER}var o = { p: 1 };\n` +
          `verifyProperty(o, "p", { value: 1, writable: true, enumerable: true, configurable: true });`,
      ),
    ).toBe("pass");
  }, 300_000);
});
