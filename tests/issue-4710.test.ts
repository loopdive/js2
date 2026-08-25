// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4710 — synchronous for-of destructuring-head TDZ during receiver evaluation.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(process.cwd(), "test262", "test");

const TARGET = "language/statements/for-of/scope-body-lex-open.js";
const CONTROLS = [
  "language/statements/for-of/scope-body-lex-boundary.js",
  "language/statements/for-of/scope-body-var-none.js",
  "language/statements/for-of/head-let-destructuring.js",
  "language/statements/for-of/body-dstr-assign.js",
] as const;

describe("#4710 — for-of destructuring-head TDZ", () => {
  it("throws through a closure created while evaluating the receiver", async () => {
    const result = await runTest262File(join(TEST262, TARGET), "issue-4710", 30_000);
    expect(result.status, JSON.stringify(result)).toBe("pass");
  });

  it.each(CONTROLS)("keeps the related control green: %s", async (file) => {
    const result = await runTest262File(join(TEST262, file), "issue-4710-control", 30_000);
    expect(result.status, JSON.stringify(result)).toBe("pass");
  });
});
