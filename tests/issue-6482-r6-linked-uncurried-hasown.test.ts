// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 round 6 — propertyHelper's `__hasOwnProperty` alias must be claimed in a
// LINKED module, not only in a standalone one.
//
// `propertyHelper.js` declares
// `__hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)`,
// and `isConfigurable` / `isWritable` are each a probe plus a call of that
// alias. `call-identifier.ts` claimed the alias — routing it to the
// `__hasOwnProperty` provider — only under `ctx.standalone || noJsHost(ctx)`.
// The linked harness PROVIDER is a js-host module, so neither held, and the
// call fell to the generic `$__bound_fn` dispatch, which runs the engine's
// `Object.prototype.hasOwnProperty` against a receiver only the READING module
// can wrap. Measured against the real provider, that answered **false for every
// consumer-minted receiver** — a plain `{a: 1}` exactly as much as a `[101]`,
// with no mutation anywhere — and no host arm was involved at all (three
// instrumentations, zero calls), so no `_decoderExportsFor` redirect could have
// reached it.
//
// The gate is now `uncurriedBuiltinAliasArmActive` (`call-object-builtins.ts`),
// which adds `linkBrandRoleOf(ctx) !== undefined`. A single-module js-host
// compile has no foreign receivers by construction and keeps the identical
// pre-#6482 path — which is what leaves #4017's 684 host-free passes and
// #4626's index-shift reasoning untouched.
//
// THESE CASES MUST RUN IN THE LINKED LANE, for the same reason
// `tests/issue-6482-r3-sparse-vec-own-indices.test.ts` documents: a
// single-module `compile()` never produces a foreign receiver, so a plain test
// asserts nothing about this fix. Verified to FAIL before the gate change.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482r6-"));
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

describe("#6482 r6 — the uncurried hasOwnProperty alias across a linked edge", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 900_000);

  // The provider-side predicate, reached through `isConfigurable` — a `delete`
  // plus the alias. Before the gate change this reported a perfectly ordinary
  // element as non-configurable (`15.2.3.7-6-a-208`).
  it("reports a consumer-minted array element as configurable", async () => {
    expect(
      await runLinked(`${HEADER}var arr = [101];\nassert.sameValue(isConfigurable(arr, "0"), true, "isConfigurable");`),
    ).toBe("pass");
  }, 600_000);

  // The `length` half of the same routing change, and the reason two narrow
  // runtime rules ship with it. Once the alias reaches the host predicate,
  // `Object.defineProperties(arr, {length: {}})` left a `length` entry in
  // `_wasmStructProps`, which `_wasmStructPropertyIsEnumerable`'s raw sidecar
  // shortcut read as ENUMERABLE; and the generic WasmGC `delete` arm tombstoned
  // `length`, which made `isConfigurable` read it as CONFIGURABLE. Both are
  // wrong on an Array (§23.1.4.1 / §10.4.2.1) and both cost
  // `Object/defineProperties/15.2.3.7-6-a-114-b` until the rules landed.
  it("keeps a consumer-minted array's length non-enumerable and non-configurable", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [];\n` +
          `Object.defineProperties(arr, { length: {} });\n` +
          `assert.sameValue(arr.length, 0, "length");\n` +
          `verifyProperty(arr, "length", { enumerable: false, configurable: false });`,
      ),
    ).toBe("pass");
  }, 600_000);

  // The alias must not start answering YES to everything: an out-of-range index
  // is still absent.
  it("still reports an out-of-range index as absent", async () => {
    expect(
      await runLinked(`${HEADER}var arr = [101];\nassert.sameValue(__hasOwnProperty(arr, "5"), false, "oob");`),
    ).toBe("pass");
  }, 600_000);
});
