// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as currentRyu from "../src/codegen/number-ryu.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
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

function legacyContext() {
  const input = sourceInput({ "./entry.ts": "export function run(): number { return 42; }" });
  return createCodegenContext(createEmptyModule(), input.checker, { standalone: true });
}

describe("canonical Ryū tables and signatures", () => {
  it.each(["cold", "digits-first", "array", "inverse", "powers"] as const)(
    "emits the legacy Ryū formatter once per module and reuses it for %s",
    (mode) => {
      const ctx = legacyContext();
      if (["array", "inverse", "powers"].includes(mode)) {
        const seed = legacyContext();
        currentRyu.emitRyuDigits(seed);
        const tableIndex = seed.arrayTypeMap.get("__ryu_i64_arr")!;
        ctx.mod.types.splice(0, ctx.mod.types.length, ...structuredClone(seed.mod.types.slice(0, tableIndex + 1)));
        ctx.arrayTypeMap.set("__ryu_i64_arr", tableIndex);
        const global = seed.mod.globals.find(
          (row) => row.name === (mode === "inverse" ? "__ryu_pow5_inv" : "__ryu_pow5"),
        );
        if (mode !== "array") ctx.mod.globals.push(structuredClone(global!));
      }
      if (mode === "digits-first") currentRyu.emitRyuDigits(ctx);
      const first = currentRyu.emitRyuToBuf(ctx, ctx.nativeStrDataTypeIdx!);
      const objects = [ctx.mod.types.slice(), ctx.mod.globals.slice(), ctx.mod.functions.slice()];
      const funcs = [...ctx.funcMap];
      expect(currentRyu.emitRyuToBuf(ctx, ctx.nativeStrDataTypeIdx!)).toBe(first);
      expect([...ctx.funcMap]).toEqual(funcs);
      for (const [index, rows] of [ctx.mod.types, ctx.mod.globals, ctx.mod.functions].entries()) {
        expect(rows).toHaveLength(objects[index]!.length);
        rows.forEach((row, i) => expect(row).toBe(objects[index]![i]));
      }
    },
  );
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
