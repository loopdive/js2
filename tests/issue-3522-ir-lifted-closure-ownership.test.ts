// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const offset = 2;
  function add(value: number): number { return value + offset; }
  return add(input);
}
`;

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === name);
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

describe("#3522 lifted nested-function ownership", () => {
  it("uses the exact inventoried nested source-unit ID instead of a derived synthetic ID", () => {
    const sourceFile = ts.createSourceFile("lifted-source-identity.ts", SOURCE, ts.ScriptTarget.Latest, true);
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
    );
    const owner = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const nested = owner.body!.statements.find(ts.isFunctionDeclaration)!;
    const ownerUnitId = identityContext.unitIdByDeclaration.get(owner)!;
    const nestedUnitId = identityContext.unitIdByDeclaration.get(nested)!;
    const lowered = lowerFunctionAstToIr(owner, { ownerUnitId, identityContext });

    expect(lowered.lifted).toHaveLength(1);
    expect(lowered.lifted[0]!.unitId).toBe(nestedUnitId);
    expect(lowered.liftedUnitProvenance).toEqual([
      expect.objectContaining({
        id: nestedUnitId,
        parentId: ownerUnitId,
        role: "lifted-closure",
        sourceUnit: true,
      }),
    ]);
  });

  it.each(TARGETS)("prepares a nested declaration and its owner atomically in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `lifted-closure-direct-${target}.ts`,
      experimentalIR: false,
      emitWat: true,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `lifted-closure-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        optimize: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared, "run")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__nested_add_0"]));
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps an unsupported nested declaration on direct ownership", async () => {
    const result = await compile(
      `export function run(input: number): number {
        function add(value?: number): number { return value ?? 0; }
        return add(input);
      }`,
      {
        fileName: "lifted-closure-optional-nested-parameter-fallback.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(41)).toBe(41);
    expect(outcome(result, "run")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "run")).not.toHaveProperty("preparedComponentId");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
