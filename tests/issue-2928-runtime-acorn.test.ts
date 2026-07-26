// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2928 E3/E6 — package the real pinned Acorn parser and interpreter as one
 * ordered, zero-import provider, then link a separately compiled user module
 * and execute indirect eval against the caller's global object.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe("#2928 — real Acorn runtime-eval provider", () => {
  it("executes linked indirect eval with one ordered zero-import provider", { timeout: 1_200_000 }, async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=3072", "--import", "tsx", join(HERE, "interp", "runtime-acorn-package-probe.mjs")],
      {
        cwd: join(HERE, ".."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.success).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.imports).toEqual([]);
    expect(report.exports).toEqual([
      { name: "__runtime_new_function", kind: "function" },
      { name: "__runtime_indirect_eval", kind: "function" },
      { name: "__runtime_eval_canary", kind: "function" },
      { name: "__runtime_function_canary", kind: "function" },
      { name: "__runtime_positive_corpus_canary", kind: "function" },
    ]);
    expect(report.userSuccess).toBe(true);
    expect(report.userErrors).toEqual([]);
    expect(report.userImports).toEqual([
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_new_function",
        kind: "function",
      },
      {
        module: "js2wasm:runtime-eval",
        name: "__runtime_indirect_eval",
        kind: "function",
      },
    ]);
    expect(report.executionErrors).toEqual({});
    expect(report.values).toEqual({
      function: 3,
      linkedFunction: 3,
      linkedFunctionImmediate: 3,
      linkedFunctionCall: 5,
      linkedSloppyThis: 1,
      linkedStrictThis: 1,
      eval: 3,
      positiveCorpus: 30,
      linkedEval: 42,
      linkedThrow: 1,
      linkedErrorThrow: 1,
      linkedNumberBuiltin: 4,
      linkedMathBuiltin: 7,
      linkedAotCall: 5,
    });
  });
});
