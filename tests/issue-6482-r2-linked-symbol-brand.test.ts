// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 mechanism 2 — a well-known symbol key crossing a linked-module edge.
//
// `Symbol.iterator` lowers to `f64.const 1; call __box_number` in a js-host
// module: `src/codegen/property-access-dispatch.ts` returned the
// `{ kind: "i32", symbol: true }` brand only under `usesNativeSymbolProvider`
// (standalone / WASI), because the js-host lane was deliberately left unbranded
// for the #4626 index-shift reason.
//
// Inside ONE module that is harmless — the well-known id never leaves, and
// every consumer of it knows statically that it is a symbol key. Across a
// wasm→wasm link (#5225) the callee's parameter is a plain `externref`, so the
// brand-less i32 boxes as the NUMBER 1. propertyHelper then reported
// `1 should be an own property` (the label is `String(name)`).
//
// The brand could not be applied until #6495: with a REAL symbol key,
// `verifyProperty`'s `isConfigurable` reaches `delete Array.prototype[name]`,
// and before #6495 that deleted from the WORKER's realm — the test process lost
// array iteration and the vitest worker hung. With the key as the number `1`
// the delete was a harmless no-op, which is how these rows "passed" honestly.
//
// Measured 2026-09-17 with the real runner on the 114-row #6482 descriptor
// bucket, on top of #6495: linked 68/114 → 98/114 (+30, 0 regressions); honest
// unchanged across 2,102 rows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports, markCoherentBuiltinRealm } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { createTestSandbox, parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482sym-"));
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
  // (#6495) The row's own realm — without it the `isConfigurable` delete below
  // reaches the WORKER's `Array.prototype` and hangs the process.
  const sandbox = createTestSandbox(console as unknown as Console, false);
  markCoherentBuiltinRealm(sandbox);
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never, {
    globalSandbox: sandbox,
  });
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

describe("#6482 r2 — a well-known symbol key survives the linked call boundary", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  // The provider's own-property check on a consumer-passed well-known symbol.
  // Unbranded this reported `1 should be an own property`.
  it("verifies Array.prototype[Symbol.iterator] from the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}verifyProperty(Array.prototype, Symbol.iterator, { writable: true, enumerable: false, configurable: true });`,
      ),
    ).toBe("pass");
  }, 300_000);

  // A non-@@iterator well-known symbol, to pin that this is the whole class and
  // not one lucky id.
  it("verifies Math[Symbol.toStringTag] from the provider", async () => {
    expect(
      await runLinked(
        `${HEADER}verifyProperty(Math, Symbol.toStringTag, { value: "Math", writable: false, enumerable: false, configurable: true });`,
      ),
    ).toBe("pass");
  }, 300_000);

  // The brand must reach the boxing path, not just the descriptor read: a
  // symbol-keyed value round-tripped through the link stays a symbol, rather
  // than arriving as its numeric well-known id.
  it("keeps a well-known symbol a symbol across the link", async () => {
    expect(await runLinked(`${HEADER}assert.sameValue(typeof Symbol.iterator, "symbol", "typeof");`)).toBe("pass");
  }, 300_000);
});
