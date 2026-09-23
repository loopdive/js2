// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import { lowerFunctionAstToIr, type AstToIrOptions, type LoweredFunctionResult } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { IrUnsupportedError } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "../src/ir/planning-identity.js";
import { NUMBER_BOUNDARY_POLICY_DISABLED, type RuntimeManifestPolicy } from "../src/ir/runtime/manifest.js";
import { RUNTIME_HOST_CAPABILITY_RECORDS } from "../src/ir/runtime/host-capabilities.js";
import { ts } from "../src/ts-api.js";

const projected = { numericThrow: "number-boundary" } as const;
const f64 = irVal({ kind: "f64" });
const externref = irVal({ kind: "externref" });
const cases = [
  { name: "original literal 17", source: "export function run(): void { throw 17; }" },
  { name: "numeric parameter", source: "export function run(value: number): void { throw value; }" },
  { name: "negative numeric expression", source: "export function run(): void { throw -17; }" },
] as const;

function lower(source: string, options: Omit<AstToIrOptions, "ownerUnitId"> = {}): LoweredFunctionResult {
  const analysis = analyzeSource(source, "issue-3527-numeric-throw.ts");
  const inventory = buildIrUnitInventory([analysis.sourceFile], {
    entrySource: analysis.sourceFile,
    checker: analysis.checker,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const declaration = analysis.sourceFile.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "run",
  );
  if (!declaration) throw new Error("missing actual run declaration");
  return lowerFunctionAstToIr(declaration, {
    ...options,
    ownerUnitId: requireIrPlanningOwnerUnitId(identity, declaration),
    identityContext: identity,
    checker: analysis.checker,
    exported: true,
  });
}

function instructions(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  for (const block of fn.blocks) {
    for (const instruction of block.instrs) forEachInstrDeep(instruction, (nested) => found.push(nested));
  }
  return found;
}

function expectBoxedThrow(fn: IrFunction): void {
  const body = instructions(fn);
  const boxes = body.filter((instruction) => instruction.kind === "intrinsic");
  const throws = body.filter((instruction) => instruction.kind === "throw");
  expect(boxes).toHaveLength(1);
  expect(throws).toHaveLength(1);
  const box = boxes[0]!;
  const thrown = throws[0]!;
  expect(box.id).toBe("js.number.box");
  expect(box.args).toHaveLength(1);
  expect(box.resultType).toEqual(externref);
  expect(box.provider).toBeUndefined();
  expect(thrown.value).toBe(box.result);
  expect(body.indexOf(box)).toBeLessThan(body.indexOf(thrown));
  expect(body.some((instruction) => instruction.kind === "coerce.to_externref")).toBe(false);
  expect(body.some((instruction) => instruction.kind === "call")).toBe(false);
  const parameter = fn.params.find((param) => param.value === box.args[0]);
  const producer = body.find((instruction) => "result" in instruction && instruction.result === box.args[0]);
  expect(parameter?.type ?? (producer && "resultType" in producer ? producer.resultType : undefined)).toEqual(f64);
}

function expectLegacyRefusal(action: () => unknown): void {
  const caught = (() => {
    try {
      action();
    } catch (error) {
      return error;
    }
    return undefined;
  })();
  expect(caught).toBeInstanceOf(IrUnsupportedError);
  expect(caught).toMatchObject({ kind: "unsupported", code: "throw-value-unsupported", stage: "build" });
}

describe("explicit source numeric-throw projection", () => {
  it.each(cases)("boxes $name once before the original throw operation", ({ source }) => {
    const result = lower(source, projected);
    expect(result.main.funcKind ?? "regular").toBe("regular");
    expect(result.main.asyncPlan).toBeUndefined();
    expectBoxedThrow(result.main);
  });

  it.each(cases)("preserves the legacy omitted-option refusal for $name", ({ source }) => {
    expectLegacyRefusal(() => lower(source));
  });

  it("preserves boolean literal refusal under the numeric-only projection", () => {
    expectLegacyRefusal(() => lower("export function run(): void { throw true; }", projected));
  });

  it.each<{ name: string; type: IrType }>([
    { name: "unbranded i32", type: irVal({ kind: "i32" }) },
    { name: "boolean-branded i32", type: irVal({ kind: "i32", boolean: true }) },
    { name: "symbol-branded i32", type: irVal({ kind: "i32", symbol: true }) },
    { name: "unsigned i32", type: { kind: "val", val: { kind: "i32" }, signed: false } },
    { name: "unsigned f64 projection", type: { kind: "val", val: { kind: "f64" }, signed: false } },
  ])("refuses $name instead of inferring number boxing from storage", ({ type }) => {
    // The override contract applies to a parameter without an annotation.
    // Prove this same source reaches throw lowering before varying its carrier.
    const source = "export function run(value): void { throw value; }";
    expectBoxedThrow(lower(source, { ...projected, paramTypeOverrides: [f64] }).main);
    expectLegacyRefusal(() => lower(source, { ...projected, paramTypeOverrides: [type] }));
  });

  it("leaves existing null/reference throw instructions unchanged", () => {
    const source = "export function run(): void { throw null; }";
    const legacy = lower(source).main;
    const opted = lower(source, projected).main;
    expect(instructions(opted)).toEqual(instructions(legacy));
    expect(instructions(opted).filter((instruction) => instruction.kind === "throw")).toHaveLength(1);
    expect(instructions(opted).some((instruction) => instruction.kind === "intrinsic")).toBe(false);
  });

  it.each([
    {
      name: "nested declaration",
      source: "export function run(): number { function inner(): number { throw 17; } return inner(); }",
    },
    {
      name: "lifted arrow",
      source: "export function run(): number { const inner = (): number => { throw 17; }; return inner(); }",
    },
  ])("propagates only the explicit projection through a $name", ({ source }) => {
    const result = lower(source, projected);
    expect(result.lifted).toHaveLength(1);
    expectBoxedThrow(result.lifted[0]!);
    expect(instructions(result.main).some((instruction) => instruction.kind === "intrinsic")).toBe(false);
    expectLegacyRefusal(() => lower(source));
  });

  it("selects a real host box provider for a regular owner without an async bridge", () => {
    const main = lower(cases[0].source, projected).main;
    const prepared = prepareIrRuntimeManifest({
      functions: [main],
      sourceFile: "issue-3527-numeric-throw.ts",
      policy: { backend: "wasmgc", target: "host", numberBoundary: { box: "host", unbox: "unsupported" } },
      includeEmpty: true,
    });
    expect(prepared.manifest.providers.map((provider) => provider.id)).toEqual(["host.js.number.box"]);
    expect(prepared.manifest.hostCapabilities).toEqual(["number.box"]);
    expect(prepared.manifest.hostCapabilityRecords).toHaveLength(1);
    expect(RUNTIME_HOST_CAPABILITY_RECORDS).toContain(prepared.manifest.hostCapabilityRecords[0]);
    expect(prepared.manifest.hostCapabilityRecords[0]).toMatchObject({
      module: "env",
      field: "__box_number",
      kind: "func",
      params: ["f64"],
      results: ["externref"],
    });
    expect(prepared.functions).toHaveLength(1);
    expect(prepared.functions[0]!.unitId).toBe(main.unitId);
    expect(prepared.functions[0]!.asyncPlan).toBeUndefined();
    const boxed = instructions(prepared.functions[0]!).find((instruction) => instruction.kind === "intrinsic");
    expect(boxed).toMatchObject({ id: "js.number.box", provider: { kind: "callable" } });
    expectBoxedThrow(main);
  });

  it.each<{ name: string; policy: RuntimeManifestPolicy }>([
    { name: "omitted", policy: { target: "host", backend: "wasmgc" } },
    {
      name: "disabled",
      policy: { target: "host", backend: "wasmgc", numberBoundary: NUMBER_BOUNDARY_POLICY_DISABLED },
    },
  ])("does not let the source projection authorize an $name number-boundary policy", ({ policy }) => {
    const main = lower(cases[0].source, projected).main;
    expectBoxedThrow(main);
    expect(() =>
      prepareIrRuntimeManifest({ functions: [main], sourceFile: "issue-3527-numeric-throw.ts", policy }),
    ).toThrow(expect.objectContaining({ code: "provider-target-unavailable" }));
  });
});
