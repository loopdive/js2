// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { sourceUnitFileSucceeded } from "./typescript-source-unit-suite.mjs";

function passingResult() {
  return {
    file: "src/testRunner/unittests/factory.ts",
    expectedTests: 3,
    native: { count: 3, statuses: [true, true, true] },
    wasm: { count: 3, statuses: [true, true, true] },
    compile: {
      success: true,
      validates: true,
      requestedTarget: "standalone",
      actualTarget: "standalone",
      targetMatches: true,
      importPolicyMatches: true,
      moduleImports: [] as unknown[],
      linkedModuleImports: [] as { imports: unknown[] }[],
    },
  };
}

it("accepts a complete zero-import source unit result", () => {
  expect(sourceUnitFileSucceeded(passingResult())).toBe(true);
});

it("rejects empty, partial, failed and unknown-file results", () => {
  expect(sourceUnitFileSucceeded(undefined)).toBe(false);
  for (const lane of ["native", "wasm"] as const) {
    const result = passingResult();
    result[lane].statuses.pop();
    expect(sourceUnitFileSucceeded(result)).toBe(false);
    result[lane].statuses.push(false);
    expect(sourceUnitFileSucceeded(result)).toBe(false);
  }
  const result = passingResult();
  result.file = "unknown.ts";
  expect(sourceUnitFileSucceeded(result)).toBe(false);
});

it("requires validation and actual zero-import standalone provenance", () => {
  for (const key of ["success", "validates", "targetMatches", "importPolicyMatches"] as const) {
    const result = passingResult();
    result.compile[key] = false;
    expect(sourceUnitFileSucceeded(result)).toBe(false);
  }
  const result = passingResult();
  result.compile.actualTarget = "gc";
  expect(sourceUnitFileSucceeded(result)).toBe(false);
  result.compile.actualTarget = "standalone";
  result.compile.moduleImports.push({ module: "env", name: "host" });
  expect(sourceUnitFileSucceeded(result)).toBe(false);
  result.compile.moduleImports = [];
  result.compile.linkedModuleImports.push({ imports: [{}] });
  expect(sourceUnitFileSucceeded(result)).toBe(false);
});
