// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const denseOwnIndexPaths = [
  "language/expressions/array/11.1.4_4-5-1.js",
  "language/expressions/array/11.1.4_5-6-1.js",
] as const;

const arrayPrototypeValuePaths = [
  "language/expressions/array/S11.1.4_A1.1.js",
  "language/expressions/array/S11.1.4_A1.2.js",
  "language/expressions/array/S11.1.4_A1.3.js",
  "language/expressions/array/S11.1.4_A1.4.js",
  "language/expressions/array/S11.1.4_A1.5.js",
  "language/expressions/array/S11.1.4_A1.6.js",
  "language/expressions/array/S11.1.4_A1.7.js",
  "language/expressions/array/S11.1.4_A2.js",
] as const;

const iterableSpreadPaths = [
  "language/expressions/array/spread-err-mult-err-iter-get-value.js",
  "language/expressions/array/spread-mult-expr.js",
  "language/expressions/array/spread-sngl-expr.js",
  "language/expressions/array/spread-sngl-iter.js",
] as const;

const objectSpreadPaths = [
  "language/expressions/array/spread-obj-manipulate-outter-obj-in-getter.js",
  "language/expressions/array/spread-obj-symbol-property.js",
  "language/expressions/array/spread-obj-with-overrides.js",
] as const;

describe("#3368 Test262 array sample residuals", () => {
  async function expectPathsToPass(paths: readonly string[]) {
    for (const path of paths) {
      const result = await runTest262File(resolve("test262/test", path), "language");
      restoreHostBuiltins();
      expect({ file: result.file, status: result.status, error: result.error }).toEqual({
        file: `test/${path}`,
        status: "pass",
        error: undefined,
      });
    }
  }

  it("passes dense own-index paths", () => expectPathsToPass(denseOwnIndexPaths), 120_000);
  it("passes inherited array prototype-value paths", () => expectPathsToPass(arrayPrototypeValuePaths), 120_000);
  it("passes iterable array-spread paths", () => expectPathsToPass(iterableSpreadPaths), 120_000);
  it("passes object-spread paths", () => expectPathsToPass(objectSpreadPaths), 120_000);
});
