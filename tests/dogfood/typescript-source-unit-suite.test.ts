// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../../src/index.js";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { SOURCE_UNIT_DIAGNOSTIC_EXPORTS, sourceUnitFileSucceeded } from "./typescript-source-unit-suite.mjs";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { readStandaloneGuestError } from "./upstream-suite-worker-protocol.mjs";

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

it("reads bounded guest error text through numeric exports only", () => {
  const text = "TypeError: sentinel π";
  expect(
    readStandaloneGuestError({
      upstreamStandaloneErrorLength: () => text.length,
      upstreamStandaloneErrorCodeUnit: (index: number) => text.charCodeAt(index),
    }),
  ).toBe(text);
  expect(readStandaloneGuestError({})).toBe("");
  for (const length of [NaN, -1, 0, 16_385]) {
    expect(
      readStandaloneGuestError({
        upstreamStandaloneErrorLength: () => length,
        upstreamStandaloneErrorCodeUnit: () => {
          throw new Error("must not read");
        },
      }),
    ).toBe("");
  }
});

it("preserves a thrown standalone callback while exposing its guest message", async () => {
  const result = await compile(
    `function runSourceUnitTestBody(index: number): number { throw new Error("source-unit sentinel"); }\n${SOURCE_UNIT_DIAGNOSTIC_EXPORTS}`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  let threw = false;
  try {
    (instance.exports.runStandaloneUpstreamTest as (index: number) => number)(0);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(readStandaloneGuestError(instance.exports)).toBe("source-unit sentinel");
});
