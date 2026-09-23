// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 — a compiled ArrayBuffer that crosses the linked module boundary must
// still be recognised AS a buffer.
//
// The compiler lowers `new ArrayBuffer(n)` to an i32_byte vec struct, and the
// only positive discriminator for that shape is the owning module's
// `__dv_byte_len` export (it answers -1 for anything else). In a linked graph
// the harness provider is its own wasm module, so a buffer the PROVIDER minted
// — every `makeArrayBuffer` / `makeResizableArrayBuffer` argument factory in
// `testTypedArray.js` — reaches the consumer's `_compiledAbToHostBuffer` with
// the CONSUMER's exports, which either do not define `__dv_byte_len` at all (a
// body that never mentions ArrayBuffer emits no such export) or `ref.test`-miss
// on the foreign type.
//
// The buffer then degraded to a generic vec and was materialised as an array of
// NUMBERS, so `new BigInt64Array(<crossed buffer>)` threw
// "Cannot convert 0 to a BigInt" — 128 rows of the linked lane's pass→fail
// residual, all of them honest-pass.
//
// The #5225 cross-module decoder registry could not answer this: its probe is
// `__struct_field_names`, and a byte vec has no field-name list, so it filed
// every buffer under NONE. `bufferDecoderFor` is the missing discriminator.
//
// Gated by construction, not by a flag: the registry short-circuits on one
// boolean below two registered modules, so every single-module compile — the
// honest test262 lane, the CLI, the playground — is byte-identical. Measured:
// honest 275-row sample before vs after, 0 verdict differences.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-ab-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = `/*---\nincludes: [testTypedArray.js, compareArray.js]\nfeatures: [BigInt, TypedArray, resizable-arraybuffer]\n---*/\n`;

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

describe("#6492 — a provider-minted ArrayBuffer keeps its brand in the consumer", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  it.each([
    [
      // The exact corpus shape: the arraybuffer arg factories feed a BigInt
      // typed-array constructor. Pre-fix this threw
      // "Cannot convert 0 to a BigInt (Testing with BigInt64Array and …)".
      "a BigInt view over an arraybuffer arg factory's result",
      `testWithAllTypedArrayConstructors(function (TA, argFactory) {\n` +
        `  var sample = new TA(argFactory(2));\n` +
        `  assert.sameValue(sample.length, 2, "two elements");\n` +
        `}, [BigInt64Array], ["arraybuffer"]);`,
    ],
    [
      // Same, for the resizable arm (`new ArrayBuffer(n, {maxByteLength})`),
      // whose struct is the `$__resizable_ab` wrapper rather than a bare vec.
      "a numeric view over the resizable arraybuffer arg factory's result",
      `testWithAllTypedArrayConstructors(function (TA, argFactory) {\n` +
        `  var sample = new TA(argFactory(4));\n` +
        `  assert.sameValue(sample.length, 4, "four elements");\n` +
        `}, [Int32Array], ["resizable"]);`,
    ],
    [
      // The direct statement of the defect, without the factory indirection: a
      // buffer the PROVIDER minted, viewed in the CONSUMER.
      "a provider-minted buffer is a real ArrayBuffer in the consumer",
      `var buffer = makeArrayBuffer(Int8Array, [1, 2, 3, 4]);\n` +
        `assert.sameValue(buffer.byteLength, 4, "byteLength crosses");\n` +
        `assert.sameValue(new Int8Array(buffer).length, 4, "a view over it has the right length");`,
    ],
  ])(
    "%s",
    async (_label, body) => {
      expect(await runLinked(HEADER + body)).toBe("pass");
    },
    300_000,
  );
});
