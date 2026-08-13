// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const valueObject = { valueOf(): number { return input + 1; } };
  const fallbackObject = { toString(): number { return 2; } };
  return +valueObject + +fallbackObject;
}
`;

function outcome(result: CompileResult): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === "run");
  expect(observed).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function importLabels(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}::${entry.name}`).sort();
}

function expectMeasuredImportSurface(
  prepared: CompileResult,
  direct: CompileResult,
  target: (typeof TARGETS)[number],
): void {
  const preparedImports = importLabels(prepared);
  const directImports = importLabels(direct);
  if (target === "standalone") {
    expect(directImports).toEqual([]);
    expect(preparedImports).toEqual([]);
    return;
  }
  expect(directImports).toEqual(["env::__box_number"]);
  expect(preparedImports).toEqual(["env::__box_number"]);
}

describe("#3522 object-method ownership", () => {
  it("keeps the lifted method on its exact inventoried object-method unit", () => {
    const sourceFile = ts.createSourceFile("object-method-identity.ts", SOURCE, ts.ScriptTarget.Latest, true);
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
    );
    const owner = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const methods = owner
      .body!.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .map((declaration) => declaration.initializer as ts.ObjectLiteralExpression)
      .map((literal) => literal.properties.find(ts.isMethodDeclaration)!);
    const ownerUnitId = identityContext.unitIdByDeclaration.get(owner)!;
    const methodUnitIds = methods.map((method) => identityContext.unitIdByDeclaration.get(method)!);
    const lowered = lowerFunctionAstToIr(owner, { ownerUnitId, identityContext });

    expect(methodUnitIds.map((unitId) => identityContext.unitByUnitId.get(unitId)?.kind)).toEqual([
      "object-method",
      "object-method",
    ]);
    expect(lowered.lifted.map((lifted) => lifted.unitId)).toEqual(methodUnitIds);
    expect(lowered.liftedUnitProvenance).toEqual(
      methodUnitIds.map((methodUnitId) =>
        expect.objectContaining({
          id: methodUnitId,
          parentId: ownerUnitId,
          role: "lifted-closure",
          sourceUnit: true,
        }),
      ),
    );
  });

  it.each(TARGETS)("prepares a captured object method and its owner atomically in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `object-method-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1";
      prepared = await compile(SOURCE, {
        fileName: `object-method-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        emitWat: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(43);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));
    expect(prepared.wat).toContain("(field $$shapeBrand");
    expect(prepared.wat).not.toContain("__call_m_");
    expectMeasuredImportSurface(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps mixed object-method/data literals on the direct path", async () => {
    const result = await compile(
      `export function run(): number {
        const object = { valueOf(): number { return 1; }, data: 2 };
        return +object;
      }`,
      {
        fileName: "object-method-mixed-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(1);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("keeps string-returning shorthand on the direct path until native conversion has size parity", async () => {
    const result = await compile(
      `export function run(): number {
        const object = { toString(): string { return "2"; } };
        return +object;
      }`,
      {
        fileName: "object-method-string-return-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(2);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });
});
