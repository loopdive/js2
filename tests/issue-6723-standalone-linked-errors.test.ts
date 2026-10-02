// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6723 D4 (errors slice) — on standalone, the linked harness provider must see
// the SAME error constructors as the test body.
//
// `assert.throws(C, fn)` runs in the PROVIDER and compares
// `thrown.constructor !== C`, where both the thrown error and `C` come from the
// CONSUMER. Every error field read and `instanceof` already worked across the
// boundary (the error struct is a canonical runtime type); identity did not:
//
//   * builtin `TypeError`/`RangeError`/…: each module answered `err.constructor`
//     from its OWN `__builtin_<Name>` carrier global, so the provider's
//     `TypeError` was a different object from the body's. Fixed by sharing the
//     cells: the provider exports them, the consumer imports them
//     (`src/codegen/standalone-link-error-ctor-cells.ts`).
//   * `Test262Error`: the body binds it to the provider's constructor
//     (`var Test262Error = <getter>()`), but lowers `new Test262Error(…)` to a
//     body-local error struct whose `constructor` neither module mapped back
//     to that binding. Fixed in `userErrorCtorCarrierGlobal` (consumer) and the
//     provider's `$Error_struct` constructor arm.
//
// Measured on the base tree: the four `assert.throws` rows printed
// "Expected a TypeError but got a undefined" (ReferenceError likewise;
// Test262Error: "…but got a Error"), and the wrong-constructor row printed
// "…but got a undefined" instead of naming RangeError. The body-side identity
// row passed before too; it guards that sharing the cells keeps it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module, resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6723-errors-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  target: "standalone" as const,
  hostBridge: "always" as const,
};

let provider: HarnessProvider | undefined;
let providerPrefix: string | undefined;

type Exports = Record<string, unknown>;

/** The worker's `drainAndCaptureNativeStdout` for a linked row, reduced. */
function readStdout(modules: Exports[]): string[] {
  const lines: string[] = [];
  for (const exp of modules) {
    const prepare = exp.__stdout_prepare as (() => number) | undefined;
    const char = exp.__stdout_char as ((i: number) => number) | undefined;
    if (typeof prepare !== "function" || typeof char !== "function") continue;
    const len = prepare() | 0;
    let out = "";
    for (let i = 0; i < len; i++) out += String.fromCharCode(char(i) & 0xffff);
    for (const line of out.split("\n")) if (line.length > 0) lines.push(line);
  }
  return lines;
}

/**
 * Compile `body` against the linked provider (assert.js + sta.js +
 * doneprintHandle.js) and run it. The body reports through `$DONE`, a provider
 * function, so the verdict is whatever the provider printed.
 */
async function runLinked(body: string): Promise<{ lines: string[]; consumerImports: number }> {
  const source = `/*---\nincludes: [doneprintHandle.js]\n---*/\n${body}`;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  if (!provider || providerPrefix !== assembly.harnessPrefix) {
    provider = await buildHarnessProvider({
      harnessPrefix: assembly.harnessPrefix,
      cacheDir: CACHE,
      compileOptions: OPTIONS,
    });
    providerPrefix = assembly.harnessPrefix;
  }
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) throw new Error(`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`);
  const importObject = buildImports(result.imports as never, undefined, result.stringPool as never) as Record<
    string,
    unknown
  >;
  // The provider imports the runtime-eval ABI (`$262.evalScript`); nothing here
  // calls it, so a refusing stub satisfies the link and keeps this test
  // independent of a prebuilt eval provider (the issue-tests CI job builds none).
  const refuse = () => {
    throw new Error("runtime-eval not available in this test");
  };
  importObject["js2wasm:runtime-eval"] = new Proxy({}, { get: () => refuse });
  const previous = process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER;
  process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = "1";
  resetTest262RuntimeEvalProviderForTest();
  let instance: WebAssembly.Instance;
  try {
    instance = (await instantiateTest262Module(result.binary, importObject, {
      target: "standalone",
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    })) as WebAssembly.Instance;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "TEST262_DISABLE_RUNTIME_EVAL_PROVIDER");
    else process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER = previous;
    resetTest262RuntimeEvalProviderForTest();
  }
  const peers = (result.linkedModules ?? [])
    .map((artifact) => importObject[artifact.namespace] as Exports | undefined)
    .filter((exp): exp is Exports => !!exp && typeof exp === "object");
  expect(peers.length).toBeGreaterThan(0);
  return { lines: readStdout([instance.exports as Exports, ...peers]), consumerImports: (result.imports ?? []).length };
}

const DONE = "Test262:AsyncTestComplete";
/** Run `assert.throws(...)` in the provider; report its failure message, if any. */
const guarded = (call: string) => `try { ${call}; $DONE(); } catch (e) { $DONE(e.message); }`;

describe("#6723 D4 — the standalone linked provider sees the body's error constructors", () => {
  it("assert.throws(TypeError) accepts a TypeError the body's runtime threw", async () => {
    const run = await runLinked(guarded(`assert.throws(TypeError, function () { null.x; })`));
    expect(run.consumerImports).toBe(0);
    expect(run.lines).toEqual([DONE]);
  }, 300_000);

  it("assert.throws(TypeError) accepts `throw new TypeError()` from the body", async () => {
    const run = await runLinked(guarded(`assert.throws(TypeError, function () { throw new TypeError("m"); })`));
    expect(run.lines).toEqual([DONE]);
  }, 300_000);

  it("assert.throws(ReferenceError) accepts an unresolvable reference from the body", async () => {
    const run = await runLinked(guarded(`assert.throws(ReferenceError, function () { unresolvable_6723; })`));
    expect(run.lines).toEqual([DONE]);
  }, 300_000);

  it("assert.throws(Test262Error) accepts `throw new Test262Error()` from the body", async () => {
    const run = await runLinked(guarded(`assert.throws(Test262Error, function () { throw new Test262Error("x"); })`));
    expect(run.lines).toEqual([DONE]);
  }, 300_000);

  it("the body and the provider agree on the constructor objects", async () => {
    const run = await runLinked(
      `try { null.x; } catch (e) { $DONE("same=" + (e.constructor === TypeError) + " name=" + e.constructor.name); }`,
    );
    expect(run.lines).toEqual(["Test262:AsyncTestFailure:Test262Error: same=true name=TypeError"]);
  }, 300_000);

  it("a WRONG constructor is still reported", async () => {
    const run = await runLinked(guarded(`assert.throws(TypeError, function () { throw new RangeError("r"); })`));
    expect(run.lines).toEqual(["Test262:AsyncTestFailure:Test262Error: Expected a TypeError but got a RangeError"]);
  }, 300_000);
});
