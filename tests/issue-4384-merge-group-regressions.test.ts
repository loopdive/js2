// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { captureSourceSlot } from "../src/codegen/closures/capture-source-slot.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fileName: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = await compile(source, {
    fileName,
    allowJs: fileName.endsWith(".js"),
    skipSemanticDiagnostics: fileName.endsWith(".js"),
    target: "gc",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (imports as { setInstance?: (value: WebAssembly.Instance) => void }).setInstance?.(instance);
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4384 merge-group regression coverage", () => {
  it("keeps unsupported host arguments.callee.caller observable as undefined", async () => {
    const exports = await run(
      `function outer() {
  function inner() { return arguments.callee.caller === undefined ? 42 : 0; }
  return inner();
}
export function test() { return outer(); }
`,
      "arguments-callee-caller.js",
    );
    expect(exports.test()).toBe(42);
  });

  it("forwards remapped async-frame locals to nested declaration captures", async () => {
    const exports = await run(
      `export async function test() {
  const expected = [0, 1, 2];
  async function* generateInput() { yield* expected; }
  const output = await Array.fromAsync(generateInput());
  return output.length === 3 && output[2] === 2 ? 42 : 0;
}
`,
      "async-frame-nested-generator.js",
    );
    await expect(exports.test()).resolves.toBe(42);
  });

  it("shares a later callable alias with a captured declaration value", async () => {
    const exports = await run(
      `var callCount = 0;
(function () {
  function f(n) {
    if (n === 0) { callCount += 1; return; }
    return eval(n - 1);
  }
  var eval = f;
  f(3);
}());
export function test() { return callCount; }
`,
      "later-callable-alias.js",
    );
    expect(exports.test()).toBe(1);
  });

  it("keeps consumers of a rejected vector-capturing sibling on the same route", async () => {
    const exports = await run(
      `const factory = function (): number {
  const values = [42];
  function wrapper(): number { return helper()[0]; }
  function helper(): number[] { return values; }
  const observed = helper;
  return wrapper();
};
export function test(): number { return factory(); }
`,
      "transitive-vector-function-value.ts",
    );
    expect(exports.test()).toBe(42);
  });

  it("uses remapped capture slots only for opted-in frames", () => {
    const fctx = {
      params: [{ name: "first", type: { kind: "externref" } }],
      locals: [
        { name: "legacy", type: { kind: "externref" } },
        { name: "unused", type: { kind: "externref" } },
        { name: "captured", type: { kind: "externref" } },
      ],
      localMap: new Map([["captured", 3]]),
    } as unknown as FunctionContext;
    const capture = { name: "captured", outerLocalIdx: 1 };

    expect(captureSourceSlot(fctx, capture)).toBe(1);
    fctx.asyncDriveReturn = { resultPromiseLocal: 0, promiseTypeIdx: 0, fulfillFuncIdx: 0 };
    expect(captureSourceSlot(fctx, capture)).toBe(3);
    fctx.liftedCaptureSlots = new Map([["captured", 2]]);
    expect(captureSourceSlot(fctx, capture)).toBe(2);
  });
});
