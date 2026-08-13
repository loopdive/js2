// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1164 ES5 residual — raw Test262 assert fallback plus the deliberately
 * narrow IR-owned `(0, eval)(string);` host call.
 *
 * The call is intentionally statement-only and JS-host-only. These tests pin
 * its positive ABI/inventory path and the syntax/runtime boundaries that must
 * remain legacy-owned until #2925/#1165.
 */

import { describe, expect, it } from "vitest";

import { exactIndirectEvalStatement } from "../src/eval-call-shape.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { hasActiveUnshadowedTest262Assert, rawTest262AssertShimEnabled } from "../src/runtime-eval.js";
import { ts } from "../src/ts-api.js";

function outcomeFor(result: CompileResult, name = "probe"): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((outcome) => outcome.displayName === name);
}

function errorsOf(result: CompileResult): string {
  return result.errors.map((error) => error.message).join("\n");
}

async function compileTracked(source: string, target?: "standalone"): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-1164-es5-eval-slice.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, errorsOf(result)).toBe(true);
  return result;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

function firstCall(source: string): ts.CallExpression {
  const sourceFile = ts.createSourceFile(
    "issue-1164-call-shape.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isCallExpression(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  expect(found, source).toBeDefined();
  return found!;
}

async function hostEvalImport(): Promise<(source: unknown, isDirect: number) => unknown> {
  const result = await compile(`export function hostEval(source: any): any { return (0, eval)(source); }`, {
    fileName: "issue-1164-host-eval-import.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, errorsOf(result)).toBe(true);
  expect(result.imports.some((descriptor) => descriptor.name === "__extern_eval")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  return imports.env.__extern_eval as (source: unknown, isDirect: number) => unknown;
}

async function withoutGlobalAssert<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "assert");
  expect(Reflect.deleteProperty(globalThis, "assert")).toBe(true);
  try {
    return await run();
  } finally {
    Reflect.deleteProperty(globalThis, "assert");
    if (previous) Object.defineProperty(globalThis, "assert", previous);
  }
}

describe("#1164 ES5 eval slice — raw Test262 assert classifier", () => {
  it("keeps the attribution switch safe when a browser has no process environment", () => {
    expect(rawTest262AssertShimEnabled(undefined)).toBe(true);
    expect(rawTest262AssertShimEnabled({})).toBe(true);
    expect(rawTest262AssertShimEnabled({ JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM: "1" })).toBe(false);
  });

  it.each([
    ["callable assert", "assert(true);"],
    ["known dot member", "assert.sameValue(1, 1);"],
    ["known bracket member", 'assert["throws"](Error, function () {});'],
    [
      "outer harness call beside a nested local binding",
      "assert.sameValue(1, 1); (function (assert) { assert.sameValue(1, 1); })({ sameValue: function () {} });",
    ],
    [
      "outer harness call beside a block-local binding",
      "if (false) { let assert = { sameValue: function () {} }; assert.sameValue(1, 1); } assert.sameValue(1, 1);",
    ],
  ])("recognizes %s", (_label, source) => {
    expect(hasActiveUnshadowedTest262Assert(source)).toBe(true);
  });

  it.each([
    ["comment", "/* assert.sameValue(1, 1) */"],
    ["string", '"assert.sameValue(1, 1)"'],
    ["template text", "`assert.sameValue(1, 1)`"],
    ["non-call reference", "assert.sameValue;"],
    ["unknown member", "assert.custom(1);"],
    ["optional call", "assert?.sameValue(1, 1);"],
    ["local binding", "let assert = { sameValue() {} }; assert.sameValue();"],
    ["parameter binding", "(function (assert) { assert.sameValue(); })(undefined);"],
    ["catch binding", "try {} catch (assert) { assert.sameValue(); }"],
  ])("does not activate for %s", (_label, source) => {
    expect(hasActiveUnshadowedTest262Assert(source)).toBe(false);
  });

  it("runs raw callable/dot/bracket Test262 assertions through the legacy fallback shim", async () => {
    await withoutGlobalAssert(async () => {
      const evaluate = await hostEvalImport();

      expect(evaluate("assert(true);", 0)).toBeUndefined();
      expect(evaluate("assert.sameValue(1, 1);", 0)).toBeUndefined();
      expect(evaluate('assert["sameValue"](1, 1);', 0)).toBeUndefined();
      expect(
        evaluate("assert.throws(TypeError, function () { throw new TypeError('expected'); });", 0),
      ).toBeUndefined();
      expect(() => evaluate("assert.sameValue(1, 2);", 0)).toThrow(/eval harness assertion/);
      expect(
        evaluate(
          "assert.sameValue(1, 1); (function (assert) { assert.sameValue(1, 1); })({ sameValue: function () {} });",
          0,
        ),
      ).toBeUndefined();
    });
  });

  it("retains a measurement-only raw-assert kill switch", async () => {
    const previous = process.env.JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM;
    process.env.JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM = "1";
    try {
      await withoutGlobalAssert(async () => {
        const evaluate = await hostEvalImport();
        expect(() => evaluate("assert.sameValue(1, 1);", 0)).toThrow(/assert is not defined/);
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM");
      else process.env.JS2WASM_DISABLE_RAW_TEST262_ASSERT_SHIM = previous;
    }
  });

  it("does not inject a raw-assert shim for inert text or a local binding", async () => {
    await withoutGlobalAssert(async () => {
      const evaluate = await hostEvalImport();
      // `with` keeps these on the legacy fallback path, where a raw
      // substring detector would otherwise prepend `var assert`.
      expect(evaluate('with ({}) { "assert.sameValue(1, 1)"; }', 0)).toBeUndefined();
      expect((globalThis as Record<string, unknown>).assert).toBeUndefined();
      expect(
        evaluate("let assert = { sameValue: function () {} }; with ({}) { assert.sameValue(); }", 0),
      ).toBeUndefined();
      expect((globalThis as Record<string, unknown>).assert).toBeUndefined();
    });
  });
});

describe("#1164 ES5 eval slice — exact host IR ownership", () => {
  it("recognizes only the canonical statement spelling", () => {
    expect(exactIndirectEvalStatement(firstCall("(0, eval)(source);"))).toBeDefined();
    expect(exactIndirectEvalStatement(firstCall("((0), (eval))(source);"))).toBeDefined();

    for (const source of [
      "eval(source);",
      "const result = (0, eval)(source);",
      "(1, eval)(source);",
      "(0, eval)();",
      "(0, eval)(source, source);",
      "(0, eval)(...sources);",
      "(0, eval)?.(source);",
    ]) {
      expect(exactIndirectEvalStatement(firstCall(source)), source).toBeUndefined();
    }
  });

  it("owns a proven-string indirect statement through IR, reserves one import, and executes raw asserts", async () => {
    const result = await compileTracked(`
      export function probe(source: string): number {
        (0, eval)(source);
        return 1;
      }
    `);

    expect(outcomeFor(result)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.imports.filter((descriptor) => descriptor.name === "__extern_eval")).toHaveLength(1);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
        (entry) => entry.module === "env" && entry.name === "__extern_eval",
      ),
    ).toEqual([{ module: "env", name: "__extern_eval", kind: "function" }]);

    await withoutGlobalAssert(async () => {
      const exports = await instantiate(result);
      const probe = exports.probe as (source: string) => number;
      expect(probe("assert.sameValue(1, 1);")).toBe(1);
      expect(probe("assert.throws(TypeError, function () { throw new TypeError(); });")).toBe(1);
      expect(() => probe("assert.sameValue(1, 2);")).toThrow(/eval harness assertion/);
    });
  });

  it.each([
    ["direct eval", `export function probe(source: string): number { eval(source); return 1; }`],
    ["value-producing indirect eval", `export function probe(source: string): unknown { return (0, eval)(source); }`],
    ["non-string union", `export function probe(source: string | number): number { (0, eval)(source); return 1; }`],
    ["zero arguments", `export function probe(): number { (0, eval)(); return 1; }`],
    ["two arguments", `export function probe(source: string): number { (0, eval)(source, source); return 1; }`],
    ["spread argument", `export function probe(sources: string[]): number { (0, eval)(...sources); return 1; }`],
    ["nonzero comma lhs", `export function probe(source: string): number { (1, eval)(source); return 1; }`],
    [
      "shadowed eval",
      `export function probe(eval: (source: string) => unknown, source: string): number { (0, eval)(source); return 1; }`,
    ],
  ])("demotes %s before IR emission", async (_label, source) => {
    const result = await compileTracked(source);
    expect(outcomeFor(result)).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the host-only statement form out of standalone IR", async () => {
    const result = await compileTracked(
      `export function probe(source: string): number { (0, eval)(source); return 1; }`,
      "standalone",
    );
    expect(outcomeFor(result)).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).some(
        (entry) => entry.module === "env" && entry.name === "__extern_eval",
      ),
    ).toBe(false);
  });
});
