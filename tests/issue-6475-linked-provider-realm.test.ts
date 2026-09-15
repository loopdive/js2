// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6475 — a linked provider must resolve the EMBEDDER's realm intrinsics.
//
// A provider's `env` is rebuilt rather than inherited (the adapter carries
// per-instance callback/host state that must not be shared with the consumer),
// but "rebuild the wrappers" was implemented as "rebuild them with no host
// context at all" — which also discarded the two things that belong to the
// EMBEDDER rather than to the instance: the host deps (`console`) and the realm
// the wrappers resolve intrinsics from (`options.globalSandbox`).
//
// The test262 runner installs a fresh per-row realm, so the consumer's
// `TypeError` is that realm's while the provider's was the ambient one: same
// name, not `===`, and `assert.throws(TypeError, …)` — evaluated INSIDE the
// provider — rejected a genuine consumer-thrown native error with
// "Expected a TypeError but got a different error constructor with the same
// name".
//
// This file pins BOTH directions, which is why the sandbox is built here rather
// than reusing `tests/issue-3451-linked-harness-substrate.test.ts`: without a
// distinct realm the bug is invisible (both sides resolve the same ambient
// constructor), so the repro case asserts the body FAILS without `linkedHost`
// and PASSES with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
// @ts-expect-error -- untyped runner helper
import { SANDBOX_GLOBAL_NAMES } from "../scripts/test262-sandbox-globals.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6475-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

/**
 * The runner's per-row realm, reduced to what this file needs
 * (`scripts/test262-worker.mjs` `buildOriginalHarnessSandbox`). The point is
 * that `sandbox.TypeError !== globalThis.TypeError` — a REAL second realm via
 * `vm.createContext`, not a hand-rolled subclass, so the identities differ the
 * same way they do in production.
 */
function buildSandbox(consoleProxy: unknown): Record<string, unknown> {
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const context = createContext(sandbox);
  for (const name of SANDBOX_GLOBAL_NAMES as readonly string[]) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      /* a name this Node build does not have */
    }
  }
  Object.defineProperties(sandbox, {
    undefined: { value: undefined, writable: false, enumerable: false, configurable: false },
    Infinity: { value: Number.POSITIVE_INFINITY, writable: false, enumerable: false, configurable: false },
    NaN: { value: Number.NaN, writable: false, enumerable: false, configurable: false },
  });
  sandbox.console = consoleProxy;
  sandbox.globalThis = sandbox;
  sandbox.$DONE = () => {};
  return sandbox;
}

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

/**
 * Run `body` in the linked lane against a fresh realm, with the provider's
 * adapter either given that realm (`withHost: true`, the fix) or not
 * (`withHost: false`, the pre-fix behaviour — the repro).
 */
async function runLinked(body: string, withHost: boolean): Promise<Verdict> {
  const source = `/*---\nincludes: [assert.js]\n---*/\n${body}`;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const sandbox = buildSandbox(console);
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never, {
    globalSandbox: sandbox,
  });
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      linkedRuntime,
      linkedHost: withHost ? { deps: { console }, options: { globalSandbox: sandbox } } : undefined,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

describe("#6475 — a linked provider resolves the embedder's realm intrinsics", () => {
  beforeAll(async () => {
    const source = `/*---\nincludes: [assert.js]\n---*/\nassert.sameValue(1, 1);`;
    await providerFor(assembleLinkedHarness(source, parseMeta(source)).harnessPrefix);
  }, 300_000);

  // The four constructors the slice-3 measurement saw fail. `assert.throws`
  // runs in the PROVIDER and compares the caught error's constructor against
  // the argument the CONSUMER resolved from the sandbox realm.
  it.each([
    ["TypeError", `assert.throws(TypeError, function () { null.x; });`],
    ["RangeError", `assert.throws(RangeError, function () { (1).toFixed(999); });`],
    ["ReferenceError", `assert.throws(ReferenceError, function () { __js2wasm_undeclared_6475; });`],
    ["SyntaxError", `assert.throws(SyntaxError, function () { JSON.parse("{"); });`],
  ])(
    "a native %s crosses to the provider's assert.throws",
    async (_name, body) => {
      expect(await runLinked(body, true)).toBe("pass");
    },
    300_000,
  );

  // The repro itself: without the host context the SAME body fails, and fails
  // for the reason the issue names. If this ever starts passing, the fix has
  // stopped being load-bearing and the threading can be re-examined — it is not
  // a redundant assertion.
  it("without linkedHost the same body fails on constructor identity", async () => {
    const verdict = await runLinked(`assert.throws(TypeError, function () { null.x; });`, false);
    expect(verdict).not.toBe("pass");
    expect(verdict).toMatch(/different error constructor with the same name/);
  }, 300_000);

  // The constraint the precedence rule exists to protect (#5225/#5353): the
  // provider's adapter state stays the PROVIDER's. Supplying `deps`/`options`
  // must not make the consumer's callback registry visible through it — a
  // harness callback registered and invoked inside the provider must still see
  // the provider's own closure state, and Test262Error identity (the #3451
  // substrate assertion) must survive unchanged with the host context present.
  it("provider-owned adapter state survives the host context", async () => {
    expect(await runLinked(`assert.throws(Test262Error, function () { throw new Test262Error("x"); });`, true)).toBe(
      "pass",
    );
    expect(
      await runLinked(`var e = new Test262Error("x"); assert(e instanceof Test262Error, "instanceof");`, true),
    ).toBe("pass");
    // A consumer callback invoked from provider code keeps consumer identity:
    // if the provider's per-instance callback state had been replaced by the
    // consumer's, this round trip would return a foreign object.
    expect(
      await runLinked(`var o = {}; assert.sameValue([o].map(function (x) { return x; })[0], o, "identity");`, true),
    ).toBe("pass");
  }, 300_000);
});
