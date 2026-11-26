// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #7428: the test262 worker refuses a Prepared result on the ordinary lane's predicate, so a warning does not refuse it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capturePreparedJobRequest,
  compileResultHasErrors,
  observePreparedExecutionJobResult,
} from "../scripts/test262-prepared-request.mjs";

const warning = { severity: "warning", code: 2350, message: "Only a void function can be called with 'new'." };
const error = { severity: "error", code: "body-shape-rejected", message: "ir/from-ast: refused" };

describe("#7428 one compile-refusal predicate for both test262 lanes", () => {
  it("refuses an unsuccessful result or an error-severity entry, never a warning alone", () => {
    expect(compileResultHasErrors({ success: true, errors: [] })).toBe(false);
    expect(compileResultHasErrors({ success: true, errors: [warning] })).toBe(false);
    expect(compileResultHasErrors({ success: true, errors: [warning, error] })).toBe(true);
    expect(compileResultHasErrors({ success: false, errors: [] })).toBe(true);
  });

  it("the worker's ordinary and Prepared refusals both ask it", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");
    expect(worker).toContain("const hasErrors = compileResultHasErrors(result);");
    expect(worker).toContain("if (preparedRequest && hasErrors) {");
    expect(worker).toContain("preparedCompilationSucceeded = !compileResultHasErrors(result);");
  });

  it("the execution report accepts a compiled result that carries only warnings", () => {
    const base = {
      target: "standalone",
      backend: "wasmgc",
      units: { sources: ["test.js"], original: [1], emitted: [1], physical: [1], abi: [1] },
    };
    const compiler = {
      preparedRuntimeExecutionObservation: (_execution: unknown, binary?: Uint8Array) =>
        binary === undefined
          ? { base }
          : {
              base,
              actualRuntimeContext: "GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE",
              actualBinary: "MATCHED_ACTUAL_ENGINE_OPERAND",
              actualImports: "MATCHED_ACTUAL_ENGINE_OPERAND",
            },
      requiredPreparedFinalArtifactObservation: () => ({ base }),
    };
    const request = capturePreparedJobRequest({
      wholeProgram: { kind: "prepared-program-required", version: 1 },
      target: "standalone",
    });
    const observe = (errors: readonly object[]) =>
      observePreparedExecutionJobResult(
        compiler,
        { success: true, errors, binary: new Uint8Array(16) },
        { imports: {} },
        request,
        "var x;",
        1,
        2,
      );
    expect(observe([warning]).emittedUnits).toBe(1);
    expect(() => observe([error])).toThrow("complete successful units/errors are missing");
  });
});
