// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 bucket 1 — `illegal cast` in a linked-lane consumer body.
//
// The canonical method-closure trampoline (`__obj_meth_tramp_<m>_cached`) is
// minted at the FIRST access to `C.prototype.m` as a value, from whatever
// signature the method has at that moment. The linked lane compiles a test262
// body as a MULTI-FILE graph, where the member-get dispatcher reserves that
// singleton before the method body has resolved its parameter ABI — so for a
// destructuring parameter the wrapper captured a module-internal tuple struct
// while the method itself ended up accepting `externref`.
//
// `finalizeMethodTrampolines` rebuilt the trampoline BODY against the final
// signature but left the wrapper func type alone, and that type is what callers
// dispatch on: the dynamic closure-call site matched the struct-param arm and
// emitted an unguarded `ref.cast` of the caller's argument, so
// `C.prototype.m([1, 2])` TRAPPED with `illegal cast`. A wasm trap is not
// catchable by wasm exception handling, so it killed the whole row instead of
// failing one assertion — which is why the #3451 slice-6 flip could not ship
// with this bucket open.
//
// The repair widens the trampoline's own func type back to the ABI the method
// actually accepts, only in the narrowing direction and only when that wider
// wrapper already exists (so every already-emitted dispatch chain still knows
// the arm). The honest lane compiles a test262 row as ONE file and does not
// reach the drift at all.

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

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: #6492\n---*/\n";

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

describe("#6492 — detached method with a destructuring parameter (linked lane)", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  it.each([
    [
      "plain method, array pattern parameter",
      "class C { method([a]) { return a; } }\n" +
        "var method = C.prototype.method;\n" +
        'assert.sameValue(method([1, 2]), 1, "detached call returns the first element");',
    ],
    [
      "generator method, elision pattern parameter",
      "class C { *method([,]) {} }\nvar method = C.prototype.method;\nmethod([1, 2]);",
    ],
    [
      "async generator method, elision pattern parameter (the sampled corpus row's shape)",
      "class C { async *method([,]) {} }\nvar method = C.prototype.method;\nmethod([1, 2]);",
    ],
    [
      "the abrupt-completion shape the corpus row asserts",
      "var iter = function* () { throw new Test262Error(); }();\n" +
        "class C { async *method([,]) {} }\n" +
        "var method = C.prototype.method;\n" +
        "assert.throws(Test262Error, function () { method(iter); });",
    ],
  ])(
    "does not trap with `illegal cast`: %s",
    async (_label, body) => {
      expect(await runLinked(HEADER + body)).toBe("pass");
    },
    300_000,
  );
});
