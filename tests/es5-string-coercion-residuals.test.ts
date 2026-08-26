// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 residuals for the ordinary ToPrimitive/String carrier boundary. Keep the
// exact rows beside one passing neighbor in each family: the neighbors make
// sure the dynamic carrier does not replace the established scalar/string
// lowering for the adjacent, non-residual shapes.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

type Lane = "gc" | "standalone";

const CASES = [
  {
    name: "String(this) observes a script toString binding",
    relative: "built-ins/String/S15.5.1.1_A1_T9.js",
    control: "built-ins/String/S15.5.1.1_A1_T1.js",
    category: "built-ins/String",
  },
  {
    name: "replace keeps an escaped callable replacement as a callback",
    relative: "built-ins/String/prototype/replace/S15.5.4.11_A1_T9.js",
    control: "built-ins/String/prototype/replace/S15.5.4.11_A1_T1.js",
    category: "built-ins/String/prototype/replace",
  },
  {
    name: "indexed object fields retain their runtime primitive carrier",
    relative: "language/expressions/assignment/S8.12.5_A2.js",
    control: "language/expressions/assignment/S8.12.5_A1.js",
    category: "language/expressions/assignment",
  },
] as const;

const TEST262_ROOT = resolve("test262/test");

async function runRow(relative: string, category: string, lane: Lane) {
  return runTest262File(
    resolve(TEST262_ROOT, relative),
    category,
    30_000,
    lane === "standalone" ? "standalone" : undefined,
  );
}

describe.each<Lane>(["gc", "standalone"])("ES5 String coercion residuals (%s)", (lane) => {
  for (const testCase of CASES) {
    it(`${testCase.name} — exact row`, async () => {
      const result = await runRow(testCase.relative, testCase.category, lane);
      expect(result.status, result.error ?? result.reason).toBe("pass");
    });

    it(`${testCase.name} — neighbor control`, async () => {
      const result = await runRow(testCase.control, testCase.category, lane);
      expect(result.status, result.error ?? result.reason).toBe("pass");
    });
  }
});
