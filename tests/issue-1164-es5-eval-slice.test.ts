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

import { exactGlobalEvalStatement } from "../src/eval-call-shape.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
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

/**
 * The JS host's `__extern_eval` shim under the `hostEval` policy (#1164/#6779), built from its import
 * descriptor. No compile produces that import any more: the JS target compiles under the native regime with
 * native strings (#6979), so legacy eval goes to the runtime-eval provider, and since #6779 the shim denies
 * dynamic code unless the host opts in. The shim's raw-assert classifier is what these tests pin.
 */
// (#6979 S7-d) The JS-host `__extern_eval` shim rows that lived here (raw-assert
// fallback, shadowed-assert, kill switch, inert-text) pinned the host-lane eval
// shim that S7-d deleted from `src/runtime.ts`; only the pure classifier rows stay.

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
});

describe("#1164 ES5 eval slice — exact host IR ownership", () => {
  it("recognizes only the canonical statement spelling", () => {
    expect(exactGlobalEvalStatement(firstCall("(0, eval)(source);"))?.direct).toBe(false);
    expect(exactGlobalEvalStatement(firstCall("((0), (eval))(source);"))?.direct).toBe(false);
    // (#7106 A2c) the same statement shape also names a direct eval; the caller proves its scope.
    expect(exactGlobalEvalStatement(firstCall("eval(source);"))?.direct).toBe(true);

    for (const source of [
      "const result = (0, eval)(source);",
      "(1, eval)(source);",
      "(0, eval)();",
      "(0, eval)(source, source);",
      "(0, eval)(...sources);",
      "(0, eval)?.(source);",
    ]) {
      expect(exactGlobalEvalStatement(firstCall(source)), source).toBeUndefined();
    }
  });

  // (#7106 A2c) The JS-host IR arm needed the host string carrier, which the JS target no longer has (native
  // strings are forced since #6979); its import collector never fires there, and this statement stays legacy.
  it("keeps a proven-string indirect statement on the legacy path on the JS target", async () => {
    const result = await compileTracked(`
      export function probe(source: string): number {
        (0, eval)(source);
        return 1;
      }
    `);

    expect(outcomeFor(result)).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.imports.filter((descriptor) => descriptor.name === "__extern_eval")).toHaveLength(0);
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
