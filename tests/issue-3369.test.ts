// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { runTest } from "../scripts/run-test262-fyi.mjs";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";

type OriginalHarnessTest = Awaited<ReturnType<typeof loadOriginalHarnessTests>>[number];

const arrayExoticPaths = [
  "language/expressions/array/11.1.4_4-5-1.js",
  "language/expressions/array/11.1.4_5-6-1.js",
  "language/expressions/array/S11.1.4_A1.4.js",
  "language/expressions/array/S11.1.4_A1.5.js",
  "language/expressions/array/S11.1.4_A1.6.js",
  "language/expressions/array/S11.1.4_A1.7.js",
] as const;

const iteratorPaths = [
  "language/expressions/array/spread-err-mult-err-iter-get-value.js",
  "language/expressions/array/spread-err-mult-err-itr-get-call.js",
  "language/expressions/array/spread-err-mult-err-itr-get-get.js",
  "language/expressions/array/spread-err-mult-err-itr-step.js",
  "language/expressions/array/spread-err-mult-err-itr-value.js",
  "language/expressions/array/spread-err-sngl-err-itr-get-call.js",
  "language/expressions/array/spread-err-sngl-err-itr-get-get.js",
  "language/expressions/array/spread-err-sngl-err-itr-get-value.js",
  "language/expressions/array/spread-err-sngl-err-itr-step.js",
  "language/expressions/array/spread-err-sngl-err-itr-value.js",
  "language/expressions/array/spread-mult-iter.js",
  "language/expressions/array/spread-sngl-iter.js",
] as const;

const exceptionPaths = [
  "language/expressions/array/spread-err-mult-err-expr-throws.js",
  "language/expressions/array/spread-err-mult-err-obj-unresolvable.js",
  "language/expressions/array/spread-err-mult-err-unresolvable.js",
  "language/expressions/array/spread-err-sngl-err-expr-throws.js",
  "language/expressions/array/spread-err-sngl-err-obj-unresolvable.js",
  "language/expressions/array/spread-err-sngl-err-unresolvable.js",
] as const;

const capturedGlobalPaths = ["language/expressions/array/spread-obj-spread-order.js"] as const;

function sortedArraySample(): string[] {
  const root = resolve("test262/test/language/expressions/array");
  return readdirSync(root, { recursive: true })
    .filter((path): path is string => typeof path === "string" && path.endsWith(".js") && !path.includes("_FIXTURE"))
    .map((path) => join("language/expressions/array", path))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 50);
}

describe("#3369 original-harness array parity", () => {
  let testsByPath: Map<string, OriginalHarnessTest>;

  beforeAll(async () => {
    const selected = [
      ...new Set([
        ...arrayExoticPaths,
        ...iteratorPaths,
        ...exceptionPaths,
        ...capturedGlobalPaths,
        ...sortedArraySample(),
      ]),
    ];
    const tests = await loadOriginalHarnessTests(selected);
    testsByPath = new Map(tests.map((test) => [test.file, test]));
  }, 120_000);

  async function expectPathsToPass(paths: readonly string[]) {
    const failures = [];
    for (const path of paths) {
      const test = testsByPath.get(path);
      expect(test, `missing original-harness record for ${path}`).toBeDefined();
      const result = await runTest(test!, "gc");
      if (!result.pass) failures.push({ path, phase: result.phase, detail: result.detail });
    }
    expect(failures).toEqual([]);
  }

  it("passes array-exotic and sparse-hole paths", () => expectPathsToPass(arrayExoticPaths), 300_000);
  it("passes custom-iterator paths", () => expectPathsToPass(iteratorPaths), 300_000);
  it("passes exception-identity paths", () => expectPathsToPass(exceptionPaths), 300_000);
  it("passes captured-global object-spread order", () => expectPathsToPass(capturedGlobalPaths), 120_000);
});
