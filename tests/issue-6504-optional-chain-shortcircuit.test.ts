// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6504 round 32 — an optional ELEMENT access that short-circuits produced `0`.
//
// `undefined?.[0]` is `undefined` (§13.3.9). It compiled to `f64.const 0`, so
// `assert.sameValue(undefined?.[0], undefined)` failed with
// `SameValue(«0», «undefined»)`. Two independent causes, both fixed here:
//
//   1. The result type. `undefined?.[0]` types as exactly `undefined`, which
//      `isNullablePrimitiveType` rejects (it is not a union of a primitive with
//      null/undefined), so the f64 result was never widened to externref and
//      the short-circuit arm emitted `f64.const 0`. A short-circuit ALWAYS
//      yields `undefined`, so any representation that cannot hold it must widen.
//   2. The nullish test. `?.` short-circuits on `null` OR `undefined`, but the
//      test was `ref.is_null` alone — and a host `undefined` externref is not
//      wasm-null, so a chain on it fell through to a real element read.
//
// The optional PROPERTY form (`undefined?.x`) was already correct, which is why
// this survived: the two forms disagreed and only one of them was exercised by
// the shapes anyone had reduced.
//
// Verdict protocol: assertions run at module TOP LEVEL, where a failure
// propagates out of instantiation. (Inside a synchronously-compiled async
// function it would not — see issue-6504-spilled-call-await.test.ts.)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6504-oc-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: 6504 optional-chain short-circuit\n---*/\n";

/** Run `body` at module top level; resolve to its failure message, or "" when it held. */
async function verdict(body: string): Promise<string> {
  const source = HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
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
    return "";
  } catch (error) {
    return String((error as { message?: string })?.message ?? error);
  }
}

describe("#6504 r32 — an optional element access that short-circuits yields undefined, not 0", () => {
  it("the verdict channel reports a real top-level failure (control)", async () => {
    expect(await verdict(`assert.sameValue(1, 2, "CONTROL");\n`)).toContain("CONTROL");
  });

  it("`undefined?.[0]` is undefined", async () => {
    expect(await verdict(`assert.sameValue(undefined?.[0], undefined, "UNDEF_BASE");\n`)).toBe("");
  });

  it("`null?.[0]` is undefined", async () => {
    expect(await verdict(`assert.sameValue(null?.[0], undefined, "NULL_BASE");\n`)).toBe("");
  });

  it("a short-circuit in a NUMERIC consumer is NaN, not 0", async () => {
    // The old lowering read `0` here and computed 1 — silently plausible, and
    // exactly the kind of wrong answer that survives a row-count check.
    expect(
      await verdict(
        `var n = undefined?.[0] + 1;
assert.sameValue(n === n, false, "NUMERIC_CONSUMER_IS_NAN");
`,
      ),
    ).toBe("");
  });

  it("the optional PROPERTY form stays correct (it always was)", async () => {
    expect(await verdict(`assert.sameValue(undefined?.x, undefined, "PROP_FORM");\n`)).toBe("");
  });

  it("a NON-nullish base still performs the read", async () => {
    // The widening must not turn a live chain into undefined.
    expect(
      await verdict(
        `assert.sameValue([7, 8]?.[1], 8, "LIVE_CHAIN");
var o = { k: 5 };
assert.sameValue(o?.["k"], 5, "LIVE_CHAIN_STRING_KEY");
`,
      ),
    ).toBe("");
  });

  it("the short-circuit does not evaluate the index expression", async () => {
    // §13.3.9: the whole chain is skipped, so a side-effecting index must not run.
    expect(
      await verdict(
        `var ran = false;
function k() { ran = true; return 0; }
assert.sameValue(undefined?.[k()], undefined, "SHORTCIRCUIT_VALUE");
assert.sameValue(ran, false, "INDEX_NOT_EVALUATED");
`,
      ),
    ).toBe("");
  });
});
