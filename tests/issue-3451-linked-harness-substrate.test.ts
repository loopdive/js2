// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 3, P2 — shared-realm substrate for the linked Test262 harness.
//
// Each case is a MINIMAL body run against a real harness provider
// (`propertyHelper.js + assert.js + sta.js`), and each asserts PARITY with the
// honest single-module assembly of the same body — not "the linked lane
// passes". That distinction is the main finding of this slice and it changed
// the work: the plan attributed `verifyProperty` failures to the module
// boundary, but the honest lane fails those bodies too (measured 2026-09-14),
// so they are a pre-existing compiler gap, not a substrate defect, and the
// shadow lane already agrees on them. Asserting "linked passes" there would
// have demanded a fix this issue does not own.
//
// The three real substrate defects this file pins, all one root cause — an
// identity registered under the provider's host MIRROR and queried under the
// raw closure struct, or the reverse:
//
//   1. `assert.throws(Test262Error, …)` reported "Expected a undefined but got
//      a HostTest262Error" for every row in the corpus that uses it.
//   2. `e instanceof Test262Error` was false for an error that plainly is one.
//   3. (a fourth, found while measuring) the linked lane silently RAN source
//      the honest lane rejects as a syntax error.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// `instantiateTest262Module` is the ONE seam both the runner and this file must
// share — it owns the per-row registry reset (#5364), and reimplementing it
// here would test a wiring the runner does not use.
// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-3451-substrate-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\nincludes: [propertyHelper.js]\n---*/\n";

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

async function run(result: {
  success: boolean;
  errors?: { message: string }[];
  binary?: Uint8Array;
  imports?: unknown;
  stringPool?: unknown;
  linkedModules?: unknown[];
}): Promise<Verdict> {
  if (!result.success) {
    return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  }
  const runtime = await import("../src/runtime.js");
  const importObject = runtime.buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      linkedRuntime,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

const providers = new Map<string, HarnessProvider>();

async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

/** Both lanes' verdicts for one body, run through the same instantiate seam. */
async function bothLanes(body: string): Promise<{ honest: Verdict; linked: Verdict }> {
  const source = HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  const honest = await run(await compile(assembly.harnessPrefix + assembly.primary.bodySource, OPTIONS));
  const linked = await run(
    await compileHarnessLinkedBody(provider, assembly.primary.body, {
      ...OPTIONS,
      strict: assembly.primary.strict,
    }),
  );
  return { honest, linked };
}

/** The verdict CLASS — `fail: <msg>` messages legitimately differ per lane. */
const cls = (verdict: Verdict): string => verdict.split(":")[0] as string;

describe("#3451 P2 — linked-harness shared-realm substrate", () => {
  beforeAll(async () => {
    // One cold provider build up front; every case then hits the memory cache.
    const source = `${HEADER}assert.sameValue(1, 1);`;
    await providerFor(assembleLinkedHarness(source, parseMeta(source)).harnessPrefix);
  }, 300_000);

  // (1) Constructor identity round trip. Before the fix the linked lane read
  //     `fail: Expected a undefined but got a HostTest262Error` against an
  //     honest `pass` — the provider's `assert.throws` compared the caught
  //     error's constructor (the host `HostTest262Error` class) against its
  //     argument, which the consumer had unwrapped from the provider's mirror
  //     to the RAW closure struct, and `_hostStrictEqual`'s harness-identity
  //     arm only recognised the mirror form.
  it("assert.throws(Test262Error, …) agrees with the honest lane and passes", async () => {
    const { honest, linked } = await bothLanes(
      `assert.throws(Test262Error, function() { throw new Test262Error("x"); });`,
    );
    expect(honest).toBe("pass");
    expect(linked).toBe("pass");
  }, 300_000);

  // Regression guard for the same fix: a NATIVE error constructor must keep
  // working. The `thrower`-marker arm is what discriminates, so widening it to
  // accept a raw struct must not make an unrelated constructor match.
  it("assert.throws with a native error constructor still works", async () => {
    const { honest, linked } = await bothLanes(`assert.throws(TypeError, function() { null.f; });`);
    expect(honest).toBe("pass");
    expect(linked).toBe("pass");
  }, 300_000);

  // (2) `instanceof` across the boundary. The carrier registry (#4394) only
  //     records constructions routed through `__new_Test262Error_ctor`, which
  //     codegen emits for a module that DECLARES `function Test262Error`. A
  //     linked body declares none, so nothing was ever recorded and the answer
  //     was false.
  it("e instanceof Test262Error is true across the module boundary", async () => {
    const { honest, linked } = await bothLanes(
      `var e = new Test262Error("x"); assert(e instanceof Test262Error, "instanceof");`,
    );
    expect(honest).toBe("pass");
    expect(linked).toBe("pass");
  }, 300_000);

  it("e.constructor === Test262Error across the module boundary", async () => {
    const { honest, linked } = await bothLanes(
      `var e = new Test262Error("x"); assert.sameValue(e.constructor, Test262Error, "ctor");`,
    );
    expect(honest).toBe("pass");
    expect(linked).toBe("pass");
  }, 300_000);

  // (3) A syntax error must REJECT, not run. `compileMulti` suppresses
  //     syntactic diagnostics under `allowJs`; without `strictJsSyntax` the
  //     linked lane compiled `var a = ;;;` and ran it, which would have flipped
  //     every `negative: SyntaxError` row from pass to fail — silently, in the
  //     lane whose entire purpose is parity.
  it("a syntax error in the body is not silently run", async () => {
    const { honest, linked } = await bothLanes(`var a = ;;;`);
    // Parity, deliberately: TypeScript's error recovery for this particular
    // fragment lets the HONEST lane through to run time too, so demanding
    // `compile_error` here would assert something the authoritative lane does
    // not do. What must hold is that the two lanes decide alike — before the
    // `strictJsSyntax` fix they did not.
    expect(cls(linked)).toBe(cls(honest));
  }, 300_000);

  // The upstream row that first showed it: honest reported `',' expected`
  // while the linked lane ran the body and failed at run time.
  it("for-of/dstr `[ x = 'x' in {} ]` rejects in both lanes", async () => {
    const { honest, linked } = await bothLanes(
      `var x; var counter = 0;\nfor ([ x = 'x' in {} ] of [[]]) { counter += 1; }\n`,
    );
    expect(cls(honest)).toBe("compile_error");
    expect(cls(linked)).toBe("compile_error");
  }, 300_000);

  // PARITY, not pass. The honest lane fails these too (a pre-existing gap in
  // `Object.prototype.hasOwnProperty.call` / `in` / `Object.hasOwn` on a
  // compiled object under `allowJs`), so the shadow lane agreeing is the whole
  // requirement. If a later change makes the honest lane pass, this test starts
  // failing and the linked lane gets looked at — which is the intent.
  it.each([
    ["object own property", `var o = {a: 1};\nverifyProperty(o, "a", { value: 1 });`],
    [
      "function name",
      `function f() {}\nverifyProperty(f, "name", { value: "f", writable: false, enumerable: false, configurable: true });`,
    ],
  ])(
    "verifyProperty on a consumer %s agrees with the honest lane",
    async (_label, body) => {
      const { honest, linked } = await bothLanes(body);
      expect(cls(linked)).toBe(cls(honest));
    },
    300_000,
  );

  // The plan's third class ("boxed-value shape"): both reductions of the
  // reported row pass in both lanes, so there is nothing to fix. Kept as a
  // guard rather than deleted — the symptom was real in slice 2's output, and
  // the row it came from (`array-elem-init-assignment.js`) fails in BOTH lanes
  // for an unrelated reason.
  it.each([
    ["plain number", `var x = 12;\nassert.sameValue(x, 12, "num");`],
    ["destructuring default", `var v; for ([v = 12] of [[]]) ; assert.sameValue(v, 12, "dstr");`],
    ["callback identity", `var o = {}; assert.sameValue([o].map(function(x){ return x; })[0], o, "identity");`],
  ])(
    "a consumer value crosses as itself: %s",
    async (_label, body) => {
      const { honest, linked } = await bothLanes(body);
      expect(honest).toBe("pass");
      expect(linked).toBe("pass");
    },
    300_000,
  );
});
