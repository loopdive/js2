// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";

// Exact genuine source fixtures retained from the independent frontend oracle
// and the original codec experiment. No manually annotated origin is admitted.
const fixtures = [
  {
    index: 0,
    files: {
      "./base.ts": "export function twice(x: number): number { return x * 2; }",
      "./entry.ts":
        'import { twice } from "./base"; export function run(x: number): number { return Math.abs(twice(x)) + x ** 2; }',
    },
  },
  {
    index: 3,
    files: {
      "./entry.ts":
        "export function run(x: number): number { const next = (y: number = 3): number => x + y; return next(2); }",
    },
  },
  {
    index: 5,
    files: {
      "./entry.ts": "let value: number = 1; export function read(): number { return value; } value = value * 10 + 3;",
    },
  },
] satisfies { index: number; files: Record<string, string> }[];

function source(files: Record<string, string>) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const policy = { target: "host" as const, backend: "wasmgc" as const };
  const input = {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    sourceMap: {
      kind: "capture-source-map" as const,
      sources: ast.sourceFiles.map((sourceFile) => ({
        sourceFile,
        projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
      })),
    },
  };
  const result = prepareIrProgramSources(input);
  expect(result.kind, result.kind === "prepared" ? undefined : result.detail).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  expect(result.sourceMap?.sources.length).toBe(ast.sourceFiles.length);
  return { result, policy };
}

describe("B3 genuine source through prepared codec", () => {
  for (const fixture of fixtures)
    it(`preserves actual catalog through real typed preparation and codec for fixture ${fixture.index}`, () => {
      const { result, policy } = source(fixture.files);
      const typed = captureTypedIrProgramInput(result);
      expect(typed.sourceMap).toEqual(result.sourceMap);
      const prepared = prepareTypedIrProgram(typed, {
        policy,
        runtimePolicies: [policy],
        controls: {
          gvnMode: "off",
          ownership: false,
          escape: false,
          verifyIntermediateAllocations: false,
          verifyDominanceNaive: true,
        },
      });
      expect(prepared.kind, JSON.stringify(prepared.kind === "prepared" ? undefined : prepared)).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error("actual typed preparation unsupported");
      const bytes = encodePreparedIrProgram(prepared.program);
      const decoded = decodePreparedIrProgram(bytes);
      expect(encodePreparedIrProgram(decoded)).toBe(bytes);
      expect(decoded.sourceMap).toEqual(result.sourceMap);
      console.info(
        "B3 actual prepared codec",
        fixture.index,
        bytes.length,
        prepared.program.ir.functions.length,
        decoded.sourceMap?.sources.length,
      );
    });
});
