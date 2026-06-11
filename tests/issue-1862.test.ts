// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1862 — residual `Binary emit error: offset is out of bounds` rows kept
// escaping into the published test262 baseline. The live vitest path uses the
// unified worker, so it must recycle and retry poison-class compile results
// before JSONL recording, not only in the older compile-only worker.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPoisonCompileError, poisonRecycleReason } from "../scripts/test262-poison-error.mjs";

const ROOT = join(__dirname, "..");

function readRepo(path: string) {
  return readFileSync(join(ROOT, path), "utf-8");
}

describe("#1862 poison-class test262 worker failures", () => {
  it("classifies the exact published residual signature as poison", () => {
    const error = "L1:1 Binary emit error: offset is out of bounds";

    expect(isPoisonCompileError(error)).toBe(true);
    expect(poisonRecycleReason(error)).toBe("poison-class compile error (#1862)");
  });

  it("keeps ordinary compile/runtime failures out of the poison retry path", () => {
    expect(isPoisonCompileError("L12:4 Cannot find name 'x'")).toBe(false);
    expect(isPoisonCompileError("returned -1 [in test()]")).toBe(false);
    expect(isPoisonCompileError("WebAssembly.LinkError: import object field is not a Function")).toBe(false);
  });

  it("makes the unified worker recycle poison compile results before negative-test pass handling", () => {
    const worker = readRepo("scripts/test262-worker.mjs");

    expect(worker).toContain('import { poisonRecycleReason } from "./test262-poison-error.mjs";');
    expect(worker).toContain("const recycleReason = poisonRecycleReason(errMsg);");
    expect(worker).toContain("if (recycleReason) {");

    const poisonBranch = worker.indexOf("if (recycleReason) {");
    const negativeBranch = worker.indexOf("// Negative parse/early tests: compile error = pass");
    expect(poisonBranch).toBeGreaterThan(-1);
    expect(negativeBranch).toBeGreaterThan(-1);
    expect(poisonBranch).toBeLessThan(negativeBranch);

    const branchBody = worker.slice(poisonBranch, negativeBranch);
    expect(branchBody).toContain('status: "compile_error"');
    expect(branchBody).toContain("recycleReason");
  });

  it("retries poison compile_error rows before the test262 JSONL fallback records them", () => {
    const shared = readRepo("tests/test262-shared.ts");

    expect(shared).toContain('import { isPoisonCompileError } from "../scripts/test262-poison-error.mjs";');
    expect(shared).toContain('label: relPath + " [poison retry]"');
    expect(shared).toContain("Poison-error retries (#1862)");

    const poisonRetry = shared.indexOf('r.status === "compile_error" && isPoisonCompileError(r.error)');
    const fallbackRecord = shared.indexOf(
      "const error = r.error ? adjustErrorLines(r.error, lineAdjustOffset) : r.status;",
    );
    expect(poisonRetry).toBeGreaterThan(-1);
    expect(fallbackRecord).toBeGreaterThan(-1);
    expect(poisonRetry).toBeLessThan(fallbackRecord);
  });
});
