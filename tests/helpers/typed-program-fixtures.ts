// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { analyzeMultiSource } from "../../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../../src/ir/program-source.js";
import type { TypedIrProgramOptions } from "../../src/ir/program-input.js";
import type { IrProgramPreparationResult, PreparedIrProgram } from "../../src/ir/program.js";

export const typedOptions: TypedIrProgramOptions = Object.freeze({
  policy: Object.freeze({ target: "standalone", backend: "wasmgc" }),
  runtimePolicies: Object.freeze([Object.freeze({ target: "standalone", backend: "wasmgc" })]),
  controls: Object.freeze({
    gvnMode: "off",
    ownership: false,
    escape: false,
    verifyIntermediateAllocations: false,
    verifyDominanceNaive: false,
  }),
});

export const scalarFiles = {
  "./math.ts": "export function double(x: number): number { return x * 2; }",
  "./entry.ts": 'import { double as twice } from "./math"; export function main(): number { return twice(20) + 2; }',
};

export const startupFiles = {
  "./base.ts": "export let digit: number = 1; digit = digit * 10 + 3;",
  "./entry.ts":
    'import { digit } from "./base"; let answer: number = digit * 10 + 2; export function read(): number { return answer; }',
};

export function sourceInput(files: Record<string, string> = scalarFiles, reverse = false) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  return {
    sourceFiles: reverse ? [...ast.sourceFiles].reverse() : ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: typedOptions.policy,
    deferTopLevelInit: false,
  };
}

export function sourcePacket(files: Record<string, string> = scalarFiles, reverse = false) {
  const source = prepareIrProgramSources(sourceInput(files, reverse));
  if (source.kind !== "prepared") throw new Error(`${source.kind}: ${source.detail}`);
  return { source, packet: captureTypedIrProgramInput(source) };
}

export function requireProgram(result: IrProgramPreparationResult): PreparedIrProgram {
  if (result.kind !== "prepared") throw new Error(`${result.kind}: ${result.detail}`);
  return result.program;
}
