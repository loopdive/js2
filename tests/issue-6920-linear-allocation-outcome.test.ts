// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import {
  assertPreparedIrProgram,
  assertPreparedIrProgramLinearAllocationEvidence,
} from "../src/ir/program-validation.js";
import { preparedLinearAllocationOutcome } from "../src/ir/program/linear-allocation-outcome.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrInvariantError, IrUnsupportedError } from "../src/shared/contracts/ir-preparation-errors.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

function actual() {
  const ast = analyzeMultiSource(
    {
      "./entry.ts":
        "export function sample(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }",
    },
    "./entry.ts",
  );
  const policy = { backend: "linear" as const, target: "standalone" as const };
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw new Error(`${source.kind}: ${source.detail}`);
  return requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("adapter control did not reach its required throw");
}

function actualRefusal(): IrUnsupportedError {
  const program = actual();
  const { linearAllocationFacts: _facts, ...old } = program;
  const error = caught(() => assertPreparedIrProgramLinearAllocationEvidence(old, old.runtime[0]!));
  expect(error).toBeInstanceOf(IrUnsupportedError);
  return error as IrUnsupportedError;
}

describe("required Linear allocation outcome adapter", () => {
  it("preserves the actual canonical required refusal fields and location identities", () => {
    const error = actualRefusal();
    const cause = error.cause as { unitId: unknown; location: unknown; sourceFile: unknown };
    const result = preparedLinearAllocationOutcome(error);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.kind).toBe("unsupported");
    expect(result.code).toBe(error.code);
    expect(result.stage).toBe(error.stage);
    expect(result.detail).toBe(error.message);
    expect(result.cause).toBe(error.cause);
    expect(result.unitId).toBe(cause.unitId);
    expect(result.location).toBe(cause.location);
    expect(result.sourceFile).toBe(cause.sourceFile);
  });

  it.each(["prepared", "provenance"] as const)("rethrows the actual %s invariant by identity", (kind) => {
    const program = actual();
    const bad =
      kind === "prepared"
        ? { ...program, abi: { entries: [...program.abi.entries, program.abi.entries[0]!] } }
        : { ...program, allocations: { size: 0, entries: [], metadata: [] } };
    const error = caught(() => assertPreparedIrProgram(bad));
    expect(error).toBeInstanceOf(kind === "prepared" ? PreparedIrProgramInvariantError : IrInvariantError);
    if (kind === "provenance") {
      const provenance = error as IrInvariantError;
      expect(provenance.code).toBe("allocation-provenance-failure");
      expect(provenance.stage).toBe("verify");
    }
    expect(caught(() => preparedLinearAllocationOutcome(error))).toBe(error);
  });

  it("rethrows an unexpected exception by identity", () => {
    const error = new Error("unexpected adapter control");
    expect(caught(() => preparedLinearAllocationOutcome(error))).toBe(error);
  });

  it.each(["cause", "unitId", "location", "sourceFile"] as const)(
    "refuses missing canonical %s without manufacturing an owner",
    (field) => {
      const actualError = actualRefusal();
      const cause = { ...(actualError.cause as Record<string, unknown>) };
      delete cause[field];
      const error = new IrUnsupportedError(
        actualError.code,
        actualError.stage,
        actualError.message,
        field === "cause" ? undefined : cause,
      );
      const failure = caught(() => preparedLinearAllocationOutcome(error));
      expect(failure).toBeInstanceOf(PreparedIrProgramInvariantError);
      expect(failure).toMatchObject({
        code: "invalid-prepared-data",
        message: "required Linear allocation refusal lacks canonical location",
      });
    },
  );
});
