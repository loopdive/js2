// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 bucket 2 — a SUSPENDING async callback handed to a linked provider.
//
// `compileArrowAsCallback` (the `__cb_<id>` host-callback bridge) compiles the
// callback body with NO async activation: every `await` is erased and the
// callback returns `undefined` instead of a promise. #4648 gave the AWAIT-FREE
// case a Promise wrapper there; the await-ful case was simply mis-lowered, and
// nothing noticed because the static call-site repair covers every call a
// single module makes itself.
//
// A separately compiled provider is exactly the case where the call is NOT made
// by this module. `asyncTest(async function () { await … })` hands the harness
// provider a callback it invokes, and the provider's `testFunc().then(…)` then
// read `.then` of null — the `Array.fromAsync` / `asyncHelpers` population of
// the linked lane (`Test262:AsyncTestFailure:TypeError: Cannot read properties
// of null (reading 'then')`, 15 of the 15 sampled rows).
//
// The fix routes such a callback through `compileArrowAsClosure`, which does
// activate the frame engine, gated on the module being a linked-package
// consumer so single-module compiles stay byte-identical.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-async-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

// A miniature stand-in for `asyncHelpers.js`'s `asyncTest`: the provider calls
// the consumer callback and reads `.then` on the result, exactly as the real
// harness does. Reporting is by `throw` because the provider has no console.
const PROVIDER_HARNESS = `
function probeThenable(f) {
  var r = f();
  if (r === null) throw new Error("PROBE:null");
  if (r === undefined) throw new Error("PROBE:undefined");
  if (typeof r.then !== "function") throw new Error("PROBE:not-thenable");
  throw new Error("PROBE:thenable");
}
function probeThenCall(f) {
  try {
    f().then(function () {}, function () {});
  } catch (e) {
    throw new Error("PROBE:threw " + e);
  }
  throw new Error("PROBE:then-ok");
}
`;

async function runLinked(body: string): Promise<string> {
  const provider = await buildHarnessProvider({
    harnessPrefix: PROVIDER_HARNESS,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  const result = await compileHarnessLinkedBody(provider, body, { ...OPTIONS, strict: false });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return "(no probe reported)";
  } catch (error) {
    return String((error as { message?: string })?.message ?? error);
  }
}

describe("#6492 — a suspending async callback crossing to a linked provider", () => {
  it.each([
    ["await of a host promise", "probeThenable(async function () { await Promise.all([]); });"],
    [
      "await of a constructed promise",
      "probeThenable(async function () { await new Promise(function (r) { r(1); }); });",
    ],
    [
      "await whose value is used",
      "probeThenable(async function () { var a = await Array.fromAsync([0, 1]); return a.length; });",
    ],
    ["two awaits", "probeThenable(async function () { await Promise.resolve(0); await Promise.all([]); });"],
  ])(
    "returns a thenable to the provider: %s",
    async (_label, body) => {
      expect(await runLinked(body)).toBe("PROBE:thenable");
    },
    300_000,
  );

  it("the provider's `f().then(…)` — the asyncHelpers.js shape — does not throw", async () => {
    expect(await runLinked("probeThenCall(async function () { await Array.fromAsync([0, 1]); });")).toBe(
      "PROBE:then-ok",
    );
  }, 300_000);
});
