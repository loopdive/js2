// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildRyuPowerTables,
  buildRyuInverseSplit,
  buildRyuSplit,
} from "../src/runtime/wasmgc/values/number-ryu-tables.js";
import {
  ryuMulShiftSignature,
  ryuDigitsSignature,
  ryuToBufferSignature,
} from "../src/runtime/wasmgc/values/number-ryu-signatures.js";

function checkReferenceType(expression: string): readonly ts.Diagnostic[] {
  const file = fileURLToPath(new URL("./__ryu_reference_type_control.ts", import.meta.url));
  const source = `import { ryuToBufferSignature } from "../src/runtime/wasmgc/values/number-ryu-signatures.js";\nryuToBufferSignature(${expression});`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options),
    originalGetSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(name, source, languageVersion, true)
      : originalGetSource(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program);
}

describe("canonical Ryū tables and signatures", () => {
  it("preserves table limb population and the combined generator order", () => {
    const tables = buildRyuPowerTables();
    expect(tables.inverse).toEqual(buildRyuInverseSplit());
    expect(tables.powers).toEqual(buildRyuSplit());
    expect([tables.inverse.length, tables.powers.length]).toEqual([582, 652]);
    expect([...tables.inverse, ...tables.powers].every((n) => n >= -(1n << 63n) && n < 1n << 63n)).toBe(true);
  });
  it("uses fresh signature tuples and the exact supplied nonnullable reference", () => {
    expect(ryuMulShiftSignature()).toEqual({
      params: [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }, { kind: "i32" }],
      results: [{ kind: "i64" }],
    });
    expect(ryuDigitsSignature()).toEqual({ params: [{ kind: "f64" }], results: [{ kind: "i64" }, { kind: "i32" }] });
    const data = { kind: "ref", typeKey: "data" } as const;
    expect(ryuToBufferSignature(data).params[2]).toBe(data);
    expect(ryuDigitsSignature().params).not.toBe(ryuDigitsSignature().params);
  });
  it("compiler-checks physical and symbolic nonnullable refs and rejects every invalid coordinate shape", () => {
    expect(checkReferenceType('{ kind: "ref", typeIdx: 7 }')).toEqual([]);
    expect(checkReferenceType('{ kind: "ref", typeKey: "data" }')).toEqual([]);
    for (const expression of [
      '{ kind: "ref_null", typeIdx: 7 }',
      '{ kind: "ref" }',
      '{ kind: "ref", typeIdx: 7, typeKey: "data" }',
      '{ kind: "anyref" }',
    ]) {
      const errors = checkReferenceType(expression);
      expect(
        errors.some(
          (error) =>
            error.file?.fileName.endsWith("__ryu_reference_type_control.ts") &&
            error.category === ts.DiagnosticCategory.Error,
        ),
      ).toBe(true);
    }
  });
});
