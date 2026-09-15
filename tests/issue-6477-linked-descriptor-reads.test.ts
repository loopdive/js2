// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6477 — property-descriptor VALUES read across the linked-harness boundary.
//
// A test262 body is top-level code, and in the JS lane top-level code ran in
// the wasm `start` section — i.e. DURING `WebAssembly.instantiate`, before
// `wireCompiledInstance` could register the consumer in the #5225 cross-module
// decoder registry. So while the body ran, the registry held ONE module (the
// provider), and every cross-module read the provider made on a struct the
// CONSUMER minted resolved with the provider's exports: `__struct_field_names`
// answers `null` for a shape it never minted, `__sget_<name>` answers a
// `ref.test`-miss default. `Object.getOwnPropertyDescriptor(obj, "foo").value`
// therefore came back `undefined` (or `0`/`null` for a number), which the
// harness reported as `foo descriptor value should be …`.
//
// Two fixes, both host-side:
//   P1 the linked body is compiled with `deferTopLevelInit` (#2796) and run by
//      `instantiateTest262Module` AFTER `wireCompiledInstance`;
//   P2 `_readOwnDescriptor` resolves its exports through `_decoderExportsFor`.
//
// The honest single-module lane must be byte-identical: it keeps its `start`
// section and exports no `__module_init` — the last test in this file pins
// exactly that, because P1's blast radius is "which module gets a start
// section" and nothing else may move.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6477-"));
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

async function compileLinked(source: string) {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  return await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
}

async function runLinked(source: string): Promise<string> {
  const result = await compileLinked(source);
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

/** True when `binary` carries a wasm `start` section (section id 8). */
function hasStartSection(binary: Uint8Array): boolean {
  let offset = 8; // magic + version
  while (offset < binary.length) {
    const id = binary[offset]!;
    offset += 1;
    let size = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = binary[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    if (id === 8) return true;
    offset += size;
  }
  return false;
}

const DESCRIPTOR_HEADER = `/*---\nincludes: [propertyHelper.js]\n---*/\n`;

describe("#6477 — descriptor reads on consumer values in the linked lane", () => {
  beforeAll(async () => {
    await providerFor(
      assembleLinkedHarness(`${DESCRIPTOR_HEADER}\n`, parseMeta(`${DESCRIPTOR_HEADER}\n`)).harnessPrefix,
    );
  }, 600_000);

  // The three minimal bodies that reproduce the issue's three message shapes.
  // (The fourth from the root-cause note — `verifyEqualTo` on a compiled ARRAY
  // index — is NOT fixed by P1/P2 and is recorded as a residual in the issue:
  // the provider's `arr[name]` read lowers to in-wasm vec access against the
  // provider's own types and never reaches a host import, so no host-side
  // decoder redirect can see it.)
  it.each([
    [
      "string value via the harness alias",
      `var obj = {}; Object.defineProperty(obj, "foo", { value: "abcd" });\n` +
        `assert.sameValue(__getOwnPropertyDescriptor(obj, "foo").value, "abcd", "harness alias desc");`,
    ],
    [
      "numeric value via the harness alias",
      `var obj = {}; Object.defineProperty(obj, "foo", { value: 1001 });\n` +
        `assert.sameValue(__getOwnPropertyDescriptor(obj, "foo").value, 1001, "numeric desc");`,
    ],
    [
      "object-literal field, read both sides of the boundary",
      `var obj = { foo: "abcd" };\n` +
        `assert.sameValue(Object.getOwnPropertyDescriptor(obj, "foo").value, "abcd", "body-side");\n` +
        `assert.sameValue(__getOwnPropertyDescriptor(obj, "foo").value, "abcd", "provider-side");`,
    ],
  ])(
    "reads the right value: %s",
    async (_label, body) => {
      expect(await runLinked(DESCRIPTOR_HEADER + body)).toBe("pass");
    },
    300_000,
  );

  it("runs the linked body from __module_init, not from a start section", async () => {
    const result = await compileLinked(`${DESCRIPTOR_HEADER}assert.sameValue(1, 1);`);
    expect(result.success).toBe(true);
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map((e) => e.name);
    expect(exports).toContain("__module_init");
    expect(hasStartSection(result.binary)).toBe(false);
  }, 300_000);

  it("leaves the honest single-module lane on its start section", async () => {
    const honest = await compile(`var obj = { foo: "abcd" };\nvar d = Object.getOwnPropertyDescriptor(obj, "foo");`, {
      ...OPTIONS,
    });
    expect(honest.success).toBe(true);
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(honest.binary)).map((e) => e.name);
    expect(exports).not.toContain("__module_init");
    expect(hasStartSection(honest.binary)).toBe(true);
  }, 300_000);
});
