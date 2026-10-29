// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7190 — two selector refusals kept four propertyHelper.js units on the
// legacy path in every test262 file that includes it (standalone):
//
//   - `expr-module-value-logical` on isEnumerable's
//     `stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name)`
//     (and, through call-graph closure, verifyEnumerable). The `!` site
//     already accepted an exactly-boolean operand; the `&&`/`||` site did not.
//   - `expr-module-value-not` on `!__getOwnPropertyDescriptor(obj, name).<attr>`
//     in verifyNotEnumerable / verifyNotConfigurable. The operand is a dynamic
//     carrier (`dyn.truthy`), not a module storage slot.
//
// Each fixture is compiled against the LITERAL upstream harness
// (`runTest262File`, standalone) and run in node against the same assembled
// source, so both the passing and the throwing paths of each helper are
// compared on real descriptors: data (enumerable / not, configurable / not),
// accessor, symbol-keyed and absent properties.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta, runTest262File } from "./test262-runner.js";
import {
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
} from "../scripts/runtime-eval-provider.mjs";
import { resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";

const HARNESS_TESTS = join(__dirname, "..", "test262", "test", "harness");

const HEADER = "/*---\nincludes: [propertyHelper.js]\n---*/\n";

// One fixture per helper path: each must run to completion in node.
const FIXTURES: Record<string, string> = {
  "not-enumerable-data-and-accessor": `
    var o = {};
    Object.defineProperty(o, "hidden", { value: 1, enumerable: false, configurable: true });
    Object.defineProperty(o, "acc", { get: function () { return 1; }, enumerable: false });
    verifyNotEnumerable(o, "hidden");
    verifyNotEnumerable(o, "acc");
  `,
  "not-enumerable-throws-on-enumerable": `
    var o = { shown: 1 };
    Object.defineProperty(o, "acc", { get: function () { return 1; }, enumerable: true });
    assert.throws(Test262Error, function () { verifyNotEnumerable(o, "shown"); });
    assert.throws(Test262Error, function () { verifyNotEnumerable(o, "acc"); });
  `,
  "not-configurable-and-throws-on-configurable": `
    var o = { c: 1 };
    Object.defineProperty(o, "fixed", { value: 1, writable: true, configurable: false });
    Object.defineProperty(o, "acc", { get: function () { return 1; }, configurable: false });
    verifyNotConfigurable(o, "fixed");
    verifyNotConfigurable(o, "acc");
    assert.throws(Test262Error, function () { verifyNotConfigurable(o, "c"); });
  `,
  "enumerable-symbol-and-throws-on-hidden": `
    var s = Symbol("s");
    var o = {};
    o[s] = 1;
    Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
    verifyEnumerable(o, s);
    assert.throws(Test262Error, function () { verifyEnumerable(o, "hidden"); });
  `,
  // Symbol and string keys at every call site keep legacy's `name` slot externref.
  "mixed-keys": `
    var shown = Symbol("shown");
    var hidden = Symbol("hidden");
    var o = { e: 1 };
    o[shown] = 1;
    Object.defineProperty(o, "fixed", { value: 1, enumerable: false, configurable: false });
    Object.defineProperty(o, hidden, { value: 1, enumerable: false, configurable: false });
    verifyEnumerable(o, shown);
    verifyEnumerable(o, "e");
    verifyNotEnumerable(o, hidden);
    verifyNotEnumerable(o, "fixed");
    verifyNotConfigurable(o, hidden);
    verifyNotConfigurable(o, "fixed");
    assert.throws(Test262Error, function () { verifyNotConfigurable(o, shown); });
  `,
  // `||` over two exact-boolean alias calls ships; a dynamic `||` whose
  // other operand is a numeric module var stays refused.
  "logical-or": `
    function hasEither(obj, a, b) { return __hasOwnProperty(obj, a) || __hasOwnProperty(obj, b); }
    function pick(o) { return o || nonIndexNumericPropertyName; }
    var s = Symbol("s");
    var o = { x: 1 };
    assert.sameValue(hasEither(o, "y", "x"), true);
    assert.sameValue(hasEither(o, s, s), false);
    assert.sameValue(pick(0), 4294967295);
    assert.sameValue(pick("v"), "v");
  `,
  // String-only keys: legacy narrows `name` to a non-null native string.
  "string-keys": `
    var o = { c: 1 };
    Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
    verifyNotEnumerable(o, "hidden");
    verifyConfigurable(o, "c");
  `,
  "absent-property-descriptor-read-throws": `
    var o = {};
    assert.throws(TypeError, function () { verifyNotEnumerable(o, "missing"); });
    assert.throws(TypeError, function () { verifyNotConfigurable(o, "missing"); });
  `,
};

// The upstream harness self-tests for the same helpers, both halves.
const SELF_TESTS = [
  "propertyhelper-verifyenumerable-enumerable.js",
  "propertyhelper-verifyenumerable-enumerable-symbol.js",
  "propertyhelper-verifyenumerable-not-enumerable.js",
  "propertyhelper-verifyenumerable-not-enumerable-symbol.js",
  "propertyhelper-verifynotenumerable-enumerable.js",
  "propertyhelper-verifynotenumerable-enumerable-symbol.js",
  "propertyhelper-verifynotenumerable-not-enumerable.js",
  "propertyhelper-verifynotenumerable-not-enumerable-symbol.js",
  "propertyhelper-verifynotconfigurable-configurable.js",
  "propertyhelper-verifynotconfigurable-not-configurable.js",
];

const UNLOCKED_UNITS = ["isEnumerable", "verifyEnumerable", "verifyNotEnumerable", "verifyNotConfigurable"];
// verifyConfigurable was already IR-claimable; with string-only keys main
// claims it and then withdraws it at the parity guard.
const NEVER_WITHDRAWN = [...UNLOCKED_UNITS, "verifyConfigurable"];

let fixtureDir = "";

async function ensureRefusalProviderCached(): Promise<void> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const dir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(dir, key, runtimeEvalRefusalCachePath)) return;
  const r = await compile(source, RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS);
  expect(r.success, "refusal provider must compile").toBe(true);
  writeCachedRuntimeEvalProvider(dir, key, r.binary!, runtimeEvalRefusalCachePath);
  resetTest262RuntimeEvalProviderForTest();
}

function assembled(path: string): string {
  const source = readFileSync(path, "utf8");
  return assembleOriginalHarness(source, parseMeta(source)).primary.source;
}

/** Throws exactly when the assembled test fails under node. */
function runInNode(path: string): void {
  vm.runInNewContext(assembled(path), {});
}

type Lane = "standalone" | "gc";

/**
 * Compiles the assembled test with the reject-arm label (`detail`) recorded.
 * The selector reads `JS2WASM_IR_SHAPE_DIAG` once at module load, so the
 * compiler is re-imported with the flag set (as in
 * tests/issue-7106-prophelper-isenumerable.test.ts).
 */
async function compileAssembled(path: string, lane: Lane = "standalone"): Promise<CompileResult> {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  vi.resetModules();
  try {
    const { compile: compileDiag } = await import("../src/index.js");
    const result = await compileDiag(assembled(path), {
      ...(lane === "standalone" ? { target: "standalone" } : {}),
      allowJs: true,
      fileName: "test.js",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as never);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const demoted = (result.irPostClaimErrors ?? []).map((error) => error.func);
    expect(demoted.filter((name) => NEVER_WITHDRAWN.includes(name))).toEqual([]);
    return result;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
    else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
    vi.resetModules();
  }
}

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName);
}

function refusal(result: CompileResult, name: string): string | undefined {
  const outcome = (result.irOutcomes ?? []).find((o) => o.displayName === name);
  expect(outcome, name).toMatchObject({ kind: "unsupported", stage: "select", irBodyEmitted: false });
  return (outcome as { detail?: string } | undefined)?.detail;
}

async function expectPassesLikeNode(path: string): Promise<void> {
  expect(() => runInNode(path)).not.toThrow();
  const result = (await runTest262File(path, "issue-7190", 60_000, "standalone")) as {
    status: string;
    error?: string;
  };
  expect(result.status, result.error).toBe("pass");
}

describe("#7190 propertyHelper — `!` over a descriptor read and `&&` over exact booleans", () => {
  beforeAll(async () => {
    await ensureRefusalProviderCached();
    fixtureDir = mkdtempSync(join(tmpdir(), "issue-7190-"));
    for (const [name, body] of Object.entries(FIXTURES)) writeFileSync(join(fixtureDir, `${name}.js`), HEADER + body);
  }, 600_000);

  // Yield between the synchronous standalone runs (see #4003 in
  // tests/es5-standalone-harness-selftests.test.ts).
  afterEach(async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  for (const lane of ["standalone", "gc"] as const) {
    it(`${lane}: the four helpers ship IR bodies when keys are mixed`, { timeout: 180_000 }, async () => {
      const result = await compileAssembled(join(fixtureDir, "mixed-keys.js"), lane);
      expect(irBodies(result)).toEqual(expect.arrayContaining(UNLOCKED_UNITS));
      expect(WebAssembly.validate(result.binary)).toBe(true);
    });

    it(`${lane}: a non-null string slot is refused before the claim, not withdrawn`, { timeout: 180_000 }, async () => {
      const result = await compileAssembled(join(fixtureDir, "string-keys.js"), lane);
      for (const name of ["verifyNotEnumerable", "verifyConfigurable"]) {
        expect(refusal(result, name), name).toMatch(/^param-dynamic-carrier-diverges-from-legacy:/);
      }
    });
  }

  it(
    "standalone: || over exact booleans ships; a numeric module operand stays refused",
    { timeout: 180_000 },
    async () => {
      const result = await compileAssembled(join(fixtureDir, "logical-or.js"));
      expect(irBodies(result)).toContain("hasEither");
      expect(refusal(result, "pick")).toMatch(/^expr-module-value-logical:/);
    },
  );

  for (const name of Object.keys(FIXTURES)) {
    it(`standalone: ${name} passes as in node`, { timeout: 180_000 }, async () => {
      await expectPassesLikeNode(join(fixtureDir, `${name}.js`));
    });
  }

  for (const file of SELF_TESTS) {
    it(`standalone: harness self-test ${file} passes as in node`, { timeout: 180_000 }, async () => {
      await expectPassesLikeNode(join(HARNESS_TESTS, file));
    });
  }
});
