// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4712 — synchronous for-of assignment-head CoverParenthesizedExpression.
// Keep the exact Test262 rows here: a source-only probe would not exercise the
// same assignment-head lowering or the literal harness assertion.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const FOR_OF_ROOT = join(TEST262_ROOT, "test", "language", "statements", "for-of");
const TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const rows = ["head-lhs-cover.js", "head-lhs-async-parens.js", "head-lhs-member.js", "head-lhs-async-dot.js"] as const;

const controls = [
  "head-expr-no-expr.js",
  "head-decl-no-expr.js",
  "head-lhs-async-invalid.js",
  "head-lhs-cover-non-asnmt-trgt.js",
  "head-lhs-invalid-asnmt-ptrn-ary.js",
  "head-lhs-invalid-asnmt-ptrn-obj.js",
  "head-lhs-non-asnmt-trgt.js",
  "head-lhs-let.js",
  "head-expr-obj-iterator-method.js",
  "head-expr-primitive-iterator-method.js",
] as const;

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

async function runRow(file: string) {
  return runTest262File(join(FOR_OF_ROOT, file), "issue-4712", 30_000);
}

describe.skipIf(!TEST262)("#4712 — synchronous for-of assignment-head cover", () => {
  for (const file of rows) {
    it(`${file} passes`, { timeout: 60_000 }, async () => {
      const result = await runRow(file);
      expect(result.status, result.error ?? "").toBe("pass");
    });
  }

  for (const file of controls) {
    it(`${file} remains passing`, { timeout: 60_000 }, async () => {
      const result = await runRow(file);
      expect(result.status, result.error ?? "").toBe("pass");
    });
  }
});
