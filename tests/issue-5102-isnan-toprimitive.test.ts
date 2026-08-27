// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5102 — standalone isNaN must observe an own data-valued Symbol.toPrimitive
// method and propagate its abrupt/non-primitive results.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const COHORT = [
  "built-ins/isNaN/toprimitive-call-abrupt.js",
  "built-ins/isNaN/toprimitive-not-callable-throws.js",
  "built-ins/isNaN/toprimitive-result-is-object-throws.js",
  "built-ins/isNaN/toprimitive-result-is-symbol-throws.js",
] as const;

const CONTROL_SOURCE = `
  function catches(f: any): number {
    try { f(); return 0; } catch (_) { return 1; }
  }

  export function test(): number {
    const abrupt: any = {};
    abrupt[Symbol.toPrimitive] = function (_hint: string): any { throw 1; };
    const nonCallable: any = {};
    nonCallable[Symbol.toPrimitive] = 42;
    const objectResult: any = {};
    objectResult[Symbol.toPrimitive] = function (_hint: string): any { return [42]; };
    const symbolResult: any = {};
    symbolResult[Symbol.toPrimitive] = function (_hint: string): any { return Symbol.toPrimitive; };
    const ordinary: any = { valueOf: function (): number { return 7; } };

    return catches(function (): any { return isNaN(abrupt); }) +
      catches(function (): any { return isNaN(nonCallable); }) +
      catches(function (): any { return isNaN(objectResult); }) +
      catches(function (): any { return isNaN(symbolResult); }) +
      (isNaN(1) === false ? 1 : 0) +
      (isNaN("not-a-number") === true ? 1 : 0) +
      (isNaN(null) === false ? 1 : 0) +
      (isNaN(ordinary) === false ? 1 : 0);
  }
`;

const GETTER_CONTROL_SOURCE = `
  export function test(): number {
    let getterCalls = 0;
    const accessor: any = {};
    Object.defineProperty(accessor, Symbol.toPrimitive, {
      get: function (): any {
        getterCalls = getterCalls + 1;
        throw 1;
      },
    });
    try { isNaN(accessor); } catch (_) {}
    return getterCalls;
  }
`;

const corpusIt = existsSync(join("test262", "harness", "assert.js")) ? it : it.skip;

async function run(file: string, target?: "standalone") {
  return runTest262File(join("test262/test", file), "issue-5102", 120_000, target);
}

async function runStandaloneControl(): Promise<{ result: number; imports: string[] }> {
  const compiled = await compile(CONTROL_SOURCE, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    fileName: "issue-5102-isnan-toprimitive-control.ts",
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!compiled.success) return { result: -1, imports: [] };
  const module = await WebAssembly.compile(compiled.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  return { result: (instance.exports as { test: () => number }).test(), imports };
}

async function runStandaloneGetterControl(): Promise<number> {
  const compiled = await compile(GETTER_CONTROL_SOURCE, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    fileName: "issue-5102-isnan-toprimitive-getter-control.ts",
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!compiled.success) return -1;
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5102 — standalone isNaN Symbol.toPrimitive abrupt results", () => {
  corpusIt.each(COHORT)("passes the exact host row %s", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  corpusIt.each(COHORT)("passes the exact standalone row %s", async (file) => {
    const result = await run(file, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps ordinary isNaN conversions and abrupt/non-primitive controls host-free", async () => {
    const { result, imports } = await runStandaloneControl();
    expect(result).toBe(8);
    expect(imports).toEqual([]);
  });

  it("leaves the excluded accessor/getter-abrupt control unchanged", async () => {
    await expect(runStandaloneGetterControl()).resolves.toBe(0);
  });
});
