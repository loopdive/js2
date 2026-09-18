// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6482 round 8 — the host cannot tell an `arguments` object from an array, so
// it asks the module that MINTED the value.
//
// Round 7 had to drop the host `__delete_property` vec-index arm wholesale. The
// arm is what makes `propertyHelper`'s `isConfigurable` — a `delete` followed by
// a presence question — work on a consumer-minted element, and it is worth six
// rows (`Object/defineProperty/15.2.3.6-4-{191,199,229,234,236,244}`). But it
// must never run on an `arguments` exotic object: §10.4.4 maps exactly
// `0 .. length-1`, so an arguments vec is DENSE and an absence marker there is a
// lie — which cost `15.2.3.6-4-538-6`.
//
// The host's only discriminator was `_argumentsObjects`, a WeakSet populated at
// the arguments MATERIALIZATION sites, and round 7 measured it answering FALSE
// for a receiver that genuinely is one. `__vec_is_arguments` answers off the
// #4658 `$__arguments_vec` brand instead — the fact the host does not have —
// resolved through `_decoderExportsFor` so a consumer-minted value is classified
// by its own module.
//
// THE THREE-VALUED CONTRACT IS LOAD-BEARING, and the middle value is the one
// that had to be measured. A first cut answered `0` ("definitely not
// arguments") whenever the ref.test ladder reached an ordinary carrier — and in
// a module that does not register the brand at all, that is every receiver. The
// wrong `0` then OVERRODE the WeakSet that had it right:
//
//   [argq] export: false  weakset: true     ← before: module overrules, wrongly
//   [argq] export: undefined  weakset: true ← after:  module abstains, host wins
//
// So a module WITHOUT the brand now answers `-1` (I do not know) to everything,
// never `0`, and the caller keeps the answer it already had.
//
// These cases must run in the LINKED lane for the reason
// `tests/issue-6482-r3-sparse-vec-own-indices.test.ts` documents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { compile } from "../src/index.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6482r8-"));
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

describe("#6482 r8 — the arguments discriminator, and the delete arm it restores", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 900_000);

  // The arm the discriminator brings back, and the shape that NEEDS it:
  // `15.2.3.6-4-199`'s full `verifyProperty` on a fresh index defined with a
  // GENERIC descriptor. propertyHelper walks every attribute, and its
  // `isConfigurable` leg is a host `delete` whose effect has to be visible to
  // the presence question that follows — which is exactly what the vec-index
  // arm of `__delete_property` provides and what round 7 had to drop.
  it("makes a host delete of an ordinary array element visible", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [];\n` +
          `Object.defineProperty(arrObj, "0", { enumerable: true });\n` +
          `verifyProperty(arrObj, "0", {\n` +
          `  value: undefined, writable: false, enumerable: true, configurable: false });`,
      ),
    ).toBe("pass");
  }, 600_000);

  // …and the receiver it must NOT touch. `15.2.3.6-4-538-6`'s shape: an
  // arguments object, an accessor define on a fresh index, then a value
  // redefine. Marking index 0 absent made it read non-configurable.
  it("leaves an arguments object dense", async () => {
    expect(
      await runLinked(
        `${HEADER}var obj = (function() { return arguments; }());\n` +
          `obj.verifySetFunc = "data";\n` +
          `Object.defineProperty(obj, "0", {\n` +
          `  get: function() { return obj.verifySetFunc; },\n` +
          `  set: function(v) { obj.verifySetFunc = v; }, enumerable: true, configurable: true });\n` +
          `Object.defineProperty(obj, "0", { value: 1001 });\n` +
          `assert.sameValue(obj[0], 1001, "obj[0]");\n` +
          `assert.sameValue(isConfigurable(obj, "0"), true, "isConfigurable");`,
      ),
    ).toBe("pass");
  }, 600_000);

  // `15.2.3.6-4-244`'s exact body — the §10.1.6.3 rejection matrix on a FRESH
  // index, which needs the pre-grow marker AND the delete arm to agree.
  it("rejects a writable:false -> writable:true redefine on a fresh index", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [];\n` +
          `Object.defineProperty(arrObj, "1", { writable: false, configurable: false });\n` +
          `assert.throws(TypeError, function() {\n` +
          `  Object.defineProperty(arrObj, "1", { writable: true });\n` +
          `}, "redefine");`,
      ),
    ).toBe("pass");
  }, 600_000);

  // ── the export's own contract ────────────────────────────────────────────
  //
  // The end-to-end cases above do not discriminate: measured, all four also
  // pass on the round-7 tree, because the in-process rig builds its provider
  // differently from the sharded runner and the delete arm is not reached the
  // same way. The rule round 8 actually establishes is the export's THREE-VALUED
  // contract, and that is checkable directly.
  //
  // A module that does not register the `$__arguments_vec` brand must answer
  // `-1` (I do not know) to EVERY receiver — never `0`. The first cut answered
  // `0` there, which overrode the host WeakSet that had the receiver right and
  // put an absence marker into an arguments vec.
  it("never answers 0 from a module with no arguments brand", async () => {
    const result = await compile(`export function mk(): number[] { return [1, 2, 3]; }`);
    expect(result.success, (result.errors ?? []).map((e: { message: string }) => e.message).join("\n")).toBe(true);
    const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
    const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, importObject as never);
    const exports = instance.exports as Record<string, unknown>;
    const isArgs = exports.__vec_is_arguments as ((v: unknown) => number) | undefined;
    expect(typeof isArgs, "__vec_is_arguments must be exported").toBe("function");
    const mk = exports.mk as () => unknown;
    // Its OWN vec, and a value it has never seen. A module with no brand has no
    // opinion about either.
    expect(isArgs!(mk())).toBe(-1);
    expect(isArgs!(null)).toBe(-1);
  }, 300_000);

  // The value-less half of the pre-grow rule, which is what
  // `15.2.3.6-4-{191,199,229,234,236}` all turn on: a define with NO `value` on
  // a FRESH index makes the index own, with the value `undefined` (§10.1.6.3
  // defaults an absent `value`), not the zero the pre-grow used to leave there.
  //
  // (`15.2.3.6-4-191` itself also pokes `Array.prototype[0]`, which is a
  // separate intrinsic-write concern — the row passes in the runner; asserting
  // it here would pin that instead of this rule.)
  it("leaves a value-less define's fresh index own and undefined", async () => {
    expect(
      await runLinked(
        `${HEADER}var arrObj = [];\n` +
          `Object.defineProperty(arrObj, "0", { configurable: false });\n` +
          `assert.sameValue(arrObj.hasOwnProperty("0"), true, "hasOwnProperty");\n` +
          `assert.sameValue(typeof arrObj[0], "undefined", "arrObj[0] is " + typeof arrObj[0]);`,
      ),
    ).toBe("pass");
  }, 600_000);
});
