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
  const offset = 2;
  const add = (value: number): number => value + offset;
  const twice = function (value: number): number { return value * 2; };
  return twice(add(input));
}
`;

const MUTABLE_SOURCE = `
export function run(input: number): number {
  let total = input;
  const add = (value: number): number => {
    total += value;
    return total;
  };
  const read = function (): number { return total; };
  return add(2) + read();
}
`;

const NESTED_SOURCE = `
export function run(input: number): number {
  const outer = (offset: number): number => {
    const inner = (value: number): number => value + offset;
    return inner(input);
  };
  return outer(2);
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

describe("#3522 closure-literal ownership", () => {
  it("keeps arrow and function-expression artifacts on their exact inventoried source IDs", () => {
    const sourceFile = ts.createSourceFile("closure-literal-source-identity.ts", SOURCE, ts.ScriptTarget.Latest, true);
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
    );
    const owner = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const declarations = owner
      .body!.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations.map((declaration) => declaration.initializer));
    const arrow = declarations.find((declaration): declaration is import("typescript").ArrowFunction =>
      ts.isArrowFunction(declaration),
    )!;
    const functionExpression = declarations.find(
      (declaration): declaration is import("typescript").FunctionExpression => ts.isFunctionExpression(declaration),
    )!;
    const lowered = lowerFunctionAstToIr(owner, {
      ownerUnitId: identityContext.unitIdByDeclaration.get(owner)!,
      identityContext,
    });

    expect(lowered.lifted.map((candidate) => candidate.unitId)).toEqual([
      identityContext.unitIdByDeclaration.get(arrow),
      identityContext.unitIdByDeclaration.get(functionExpression),
    ]);
    expect(lowered.liftedUnitProvenance).toEqual([
      expect.objectContaining({ sourceUnit: true, role: "lifted-closure" }),
      expect.objectContaining({ sourceUnit: true, role: "lifted-closure" }),
    ]);
  });

  it("keeps a nested closure tree on exact source IDs under one terminal owner", () => {
    const sourceFile = ts.createSourceFile(
      "nested-closure-source-identity.ts",
      NESTED_SOURCE,
      ts.ScriptTarget.Latest,
      true,
    );
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory([sourceFile], { entrySource: sourceFile }),
    );
    const owner = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const arrows: import("typescript").ArrowFunction[] = [];
    const visit = (node: import("typescript").Node): void => {
      if (ts.isArrowFunction(node)) arrows.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(owner.body!, visit);
    const lowered = lowerFunctionAstToIr(owner, {
      ownerUnitId: identityContext.unitIdByDeclaration.get(owner)!,
      identityContext,
    });

    expect(arrows).toHaveLength(2);
    expect(new Set(lowered.lifted.map((candidate) => candidate.unitId))).toEqual(
      new Set(arrows.map((arrow) => identityContext.unitIdByDeclaration.get(arrow))),
    );
    expect(lowered.liftedUnitProvenance).toEqual([
      expect.objectContaining({ sourceUnit: true, role: "lifted-closure" }),
      expect.objectContaining({ sourceUnit: true, role: "lifted-closure" }),
    ]);
  });

  it.each(TARGETS)("prepares closure literals and their owner in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `closure-literal-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `closure-literal-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        emitWat: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(84);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));
    expect(prepared.wat).not.toContain("__sget_cap");
    expect(prepared.wat).not.toContain("__struct_field_names");
    if (target === "gc") expect(prepared.wat).not.toContain("__is_data_struct");
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("shares one prepared mutable capture across sibling closures in the %s lane", async (target) => {
    const direct = await compile(MUTABLE_SOURCE, {
      fileName: `closure-literal-mutable-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(MUTABLE_SOURCE, {
        fileName: `closure-literal-mutable-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        emitWat: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(5)).toBe(14);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));
    expect(prepared.wat).toContain("__ref_cell_f64");
    expect(prepared.wat).not.toContain("__sget_cap");
    expect(prepared.wat).not.toContain("__struct_field_names");
    if (target === "gc") expect(prepared.wat).not.toContain("__is_data_struct");
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("prepares nested closure trees atomically in the %s lane", async (target) => {
    const direct = await compile(NESTED_SOURCE, {
      fileName: `nested-closure-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(NESTED_SOURCE, {
        fileName: `nested-closure-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
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
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining(["run", "run__closure_0", "run__closure_0__closure_1"]),
    );
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });
});
