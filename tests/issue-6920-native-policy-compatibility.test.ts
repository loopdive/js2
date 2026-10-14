// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { IrUnsupportedError } from "../src/shared/contracts/ir-preparation-errors.js";
import { typedOptions } from "./helpers/typed-program-fixtures.js";

const host = { backend: "wasmgc", target: "host" } as const;
const linearHost = { backend: "linear", target: "host" } as const;
const native = { backend: "linear", target: "standalone" } as const;
function source(text: string) {
  const ast = analyzeMultiSource({ "entry.ts": text }, "entry.ts");
  return { sourceFiles: ast.sourceFiles, entrySource: ast.entryFile, checker: ast.checker, deferTopLevelInit: false };
}
const vector =
  "export function run(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1]; }";

describe("native policy admission preserves the existing legacy preparation contract", () => {
  it("retains both legacy scalar projections without attaching native allocation facts", () => {
    const result = prepareWholeIrProgram({
      ...source("export function run(x: number): number { return x + 1; }"),
      policy: host,
      runtimePolicies: [host, linearHost],
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.program.runtime.map(({ backend, target }) => ({ backend, target }))).toEqual([host, linearHost]);
    expect(Object.hasOwn(result.program, "linearAllocationFacts")).toBe(false);
  });
  it("does not turn explicit native source selection into a host compatibility route", () => {
    const input = { ...source(vector), policy: host, linearVectorProjection: "native-f64" as const };
    expect(() => prepareIrProgramSources(input)).toThrow(IrUnsupportedError);
    expect(() => prepareWholeIrProgram(input)).toThrow(IrUnsupportedError);
  });
  it("refuses host projection of native vectors even after relabeling the startup observer", () => {
    const result = prepareIrProgramSources({
      ...source(vector),
      policy: native,
      linearVectorProjection: "native-f64",
    });
    if (result.kind !== "prepared") throw new Error(result.detail);
    const packet = captureTypedIrProgramInput(result);
    const relabeled = {
      ...packet,
      startup: packet.startup.map((plan) => ({
        ...plan,
        invocation: { ...plan.invocation, target: "host" as const },
      })),
    };
    expect(() =>
      prepareTypedIrProgram(relabeled, {
        ...typedOptions,
        policy: linearHost,
        runtimePolicies: [linearHost],
      }),
    ).toThrow(IrUnsupportedError);
  });
  it("refuses mixed host/native policy populations rather than hiding a host view", () => {
    expect(() =>
      prepareWholeIrProgram({
        ...source("export function run(x: number): number { return x + 1; }"),
        policy: host,
        runtimePolicies: [host, native],
      }),
    ).toThrow(IrUnsupportedError);
  });
});
