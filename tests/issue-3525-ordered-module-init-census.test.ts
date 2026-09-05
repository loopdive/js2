// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource, type MultiTypedAST } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateMultiModule } from "../src/codegen/index.js";
import {
  assertMultiPreparedModuleInitCensusCurrent,
  buildMultiPreparedModuleInitCensus,
  projectMultiPreparedModuleInitCensus,
  reconcileMultiPreparedModuleInitCensus,
  type MultiPreparedModuleInitCensus,
} from "../src/codegen/multi-prepared-module-init-census.js";
import { collectModuleInitPopulation } from "../src/ir/module-init.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { CodegenContext, CodegenOptions } from "../src/codegen/context/types.js";
import { ts } from "../src/ts-api.js";

import "../src/codegen/expressions.js";

const OPTIONS: CodegenOptions = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone",
  trackIrOutcomes: true,
};

const CONTRIBUTOR_FILES = {
  "./types.ts": `export interface Marker { readonly tag: "type-only"; }`,
  "./dep.ts": `export let value: number = 40; value = value + 2;`,
  "./reexport.ts": `export { value } from "./dep";`,
  "./entry.ts": `import { value } from "./reexport"; export function read(): number { return value; }`,
} as const;

const TWO_CONTRIBUTOR_FILES = {
  "./left.ts": `export let value: number = 1;`,
  "./right.ts": `export let value: number = 2;`,
  "./entry.ts": `export interface Marker { readonly tag: "entry"; }`,
} as const;

const CYCLE_FILES = {
  "./a.ts": `import { b } from "./b"; export let a: number = b + 1;`,
  "./b.ts": `import { a } from "./a"; export let b: number = a + 1;`,
  "./entry.ts": `import { a } from "./a"; export function read(): number { return a; }`,
} as const;

interface CensusFixture {
  readonly ast: MultiTypedAST;
  readonly census: MultiPreparedModuleInitCensus;
  readonly ctx: CodegenContext;
}

function fixture(
  files: Record<string, string>,
  entryFile = "./entry.ts",
  options: CodegenOptions = OPTIONS,
): CensusFixture {
  const ast = analyzeMultiSource(files, entryFile);
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const mod = createEmptyModule();
  const session = new ProgramAbiSession(inventory, mod);
  const ctx = createCodegenContext(mod, ast.checker, options, session, identityContext);
  const census = buildMultiPreparedModuleInitCensus({
    multiAst: ast,
    identityContext,
    target: "standalone",
    deferTopLevelInit: !!ctx.deferTopLevelInit,
  });
  return { ast, census, ctx };
}

function sourcePlan(census: MultiPreparedModuleInitCensus, fileName: string) {
  const plan = census.sourcePlans.find((candidate) => candidate.sourceFile.fileName === fileName);
  if (!plan) throw new Error(`missing census source ${fileName}`);
  return plan;
}

function observe(fixtureValue: CensusFixture) {
  fixtureValue.ctx.moduleInitStatements = fixtureValue.census.sourcePlans.flatMap((source) =>
    collectModuleInitPopulation(source.sourceFile),
  );
  fixtureValue.ctx.staticInitExprs = [];
  return reconcileMultiPreparedModuleInitCensus(fixtureValue.census, { ctx: fixtureValue.ctx });
}

afterEach(() => vi.unstubAllEnvs());

describe("#3525 ordered whole-program module-init census", () => {
  it("retains every source plan and separates canonical from semantic order", () => {
    const value = fixture(CONTRIBUTOR_FILES);
    const { census } = value;
    expect(census.schema).toBe("multi-prepared-module-init-census-v1");
    expect(census.sourcePlans).toHaveLength(4);
    expect(census.sourcePlans.map((source) => source.semanticOrder)).toEqual([0, 1, 2, 3]);
    expect(census.canonicalSources.map((source) => source.canonicalOrder)).toEqual([0, 1, 2, 3]);
    expect(census.semanticSourceIds).toEqual(census.sourcePlans.map((source) => source.sourceId));
    expect(census.canonicalSourceIds).toEqual(census.canonicalSources.map((source) => source.sourceId));
    expect(census.executableSourceIds).toEqual([sourcePlan(census, "dep.ts").sourceId]);
    expect(census.executableUnitIds).toEqual([sourcePlan(census, "dep.ts").unitId]);
    expect(sourcePlan(census, "types.ts").plan.evaluations).toEqual([]);
    expect(sourcePlan(census, "reexport.ts").plan.evaluations).toEqual([]);
    expect(sourcePlan(census, "dep.ts").plan.evaluations.map((entry) => entry.sourceOrdinal)).toEqual([0, 1]);
    expect(sourcePlan(census, "dep.ts").plan.exports.map((entry) => entry.externalName)).toEqual(["value"]);
    expect(census.semanticEntryCount).toBe(2);
    expect(census.parityObserved).toBe(false);
    expect(Object.isFrozen(census)).toBe(true);
    expect(Object.isFrozen(census.sourcePlans)).toBe(true);
    expect(Object.isFrozen(sourcePlan(census, "dep.ts").plan)).toBe(true);
  });

  it("covers empty, multiple-contributor, re-export, same-spelled, and cyclic graphs", () => {
    const empty = fixture({
      "./dep.ts": `export interface Dep { readonly tag: "dep"; }`,
      "./entry.ts": `import type { Dep } from "./dep"; export type Entry = Dep;`,
    });
    expect(empty.census.executableSourceIds).toEqual([]);
    expect(empty.census.sourcePlans.every((source) => source.plan.evaluations.length === 0)).toBe(true);

    const multiple = fixture(TWO_CONTRIBUTOR_FILES);
    expect(multiple.census.executableSourceIds).toHaveLength(2);
    expect(new Set(multiple.census.executableUnitIds).size).toBe(2);

    const sameSpelled = fixture({
      "./a.ts": `export function same(): number { return 1; }`,
      "./b.ts": `export function same(): number { return 2; }`,
      "./entry.ts": `export interface Entry { readonly tag: "entry"; }`,
    });
    expect(sameSpelled.census.sourcePlans).toHaveLength(3);
    expect(sameSpelled.census.executableSourceIds).toEqual([]);

    const cycle = fixture(CYCLE_FILES);
    expect(cycle.census.sourcePlans.filter((source) => source.executable)).toHaveLength(2);
    expect(cycle.census.sourcePlans.filter((source) => source.executable).every((source) => source.unitId)).toBe(true);
  });

  it("keeps inventory canonical order independent from a reversed semantic source list", () => {
    const normal = fixture(CONTRIBUTOR_FILES);
    const reversedAst = {
      ...normal.ast,
      sourceFiles: [...normal.ast.sourceFiles].reverse(),
    } as MultiTypedAST;
    const reversed = buildMultiPreparedModuleInitCensus({
      multiAst: reversedAst,
      identityContext: normal.census.identityContext,
      target: "standalone",
      deferTopLevelInit: false,
    });
    expect(reversed.canonicalSourceIds).toEqual(normal.census.canonicalSourceIds);
    expect(reversed.semanticSourceIds).toEqual([...normal.census.semanticSourceIds].reverse());
    expect(reversed.canonicalSources.map((source) => source.sourceId)).toEqual(normal.census.canonicalSourceIds);
    expect(reversed.sourcePlans.map((source) => source.semanticOrder)).toEqual([0, 1, 2, 3]);
    expect(reversed.sourcePlans.map((source) => source.sourceId)).toEqual(
      [...normal.census.semanticSourceIds].reverse(),
    );
  });

  it("attaches one exact queue observation without rebuilding semantic plans", () => {
    const value = fixture({
      "./dep.ts": `let value: number = 40; value = value + 2;`,
      "./entry.ts": `import { value } from "./dep"; export function read(): number { return value; }`,
    });
    const before = sourcePlan(value.census, "dep.ts").plan;
    const observed = observe(value);
    const dep = sourcePlan(observed, "dep.ts");
    expect(observed.parityObserved).toBe(true);
    expect(dep.plan).toBe(before);
    expect(dep.parityAvailable).toBe(true);
    expect(dep.planning?.plan).toBe(before);
    expect(dep.planning?.parity.aligned).toBe(true);
    expect(dep.parity).toBe(dep.planning?.parity);
    expect(observed.sourcePlans.find((source) => source.sourceFile.fileName === "entry.ts")?.parity?.aligned).toBe(
      true,
    );
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(dep.planning)).toBe(true);
  });

  it("keeps a real nonempty semantic plan visible when parity is unavailable", () => {
    const value = fixture({
      "./dep.ts": `let value: number = 40; value = value + 2;`,
      "./entry.ts": `export interface Entry { readonly tag: "entry"; }`,
    });
    const unavailable = reconcileMultiPreparedModuleInitCensus(value.census, {
      ctx: value.ctx,
      legacy: { available: false },
    });
    const dep = sourcePlan(unavailable, "dep.ts");
    expect(dep.plan.evaluations.length).toBeGreaterThan(0);
    expect(dep.parityAvailable).toBe(false);
    expect(dep.planning).toBeUndefined();
    expect(unavailable.executableSourceIds).toEqual([dep.sourceId]);
    expect(unavailable.parityObserved).toBe(true);
  });

  it("rejects changed AST syntax and changed queues after their authority is retained", () => {
    const syntaxValue = fixture({
      "./dep.ts": `export let value: number = 40; value = value + 2;`,
      "./entry.ts": `export interface Entry { readonly tag: "entry"; }`,
    });
    const declaration = syntaxValue.ast.sourceFiles
      .find((source) => source.fileName === "dep.ts")!
      .statements.find((statement) => ts.isVariableStatement(statement)) as ts.VariableStatement;
    const variable = declaration.declarationList.declarations[0]!;
    const literal = variable.initializer as ts.NumericLiteral & { text: string };
    literal.text = "41";
    expect(() => assertMultiPreparedModuleInitCensusCurrent(syntaxValue.census)).toThrow(
      /multi-prepared-module-init-census:syntax-changed/,
    );
    literal.text = "40";
    expect(() => assertMultiPreparedModuleInitCensusCurrent(syntaxValue.census)).not.toThrow();
    (variable as ts.VariableDeclaration & { initializer?: ts.Expression }).initializer =
      ts.factory.createNumericLiteral("41");
    expect(() => assertMultiPreparedModuleInitCensusCurrent(syntaxValue.census)).toThrow(
      /multi-prepared-module-init-census:syntax-changed/,
    );

    const queueValue = fixture({
      "./dep.ts": `let value: number = 40;`,
      "./entry.ts": `export interface Entry { readonly tag: "entry"; }`,
    });
    const observed = observe(queueValue);
    queueValue.ctx.moduleInitStatements.push(queueValue.ast.entryFile.statements[0]!);
    expect(() => assertMultiPreparedModuleInitCensusCurrent(observed)).toThrow(
      /multi-prepared-module-init-census:parity-changed/,
    );
  });

  it("publishes the complete census in enabled and disabled program audits", () => {
    const files = {
      "./dep.ts": `let value: number = 40; value = value + 2;`,
      "./entry.ts": `import { value } from "./dep"; export function read(): number { return value; }`,
    } as const;
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    const enabled = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), OPTIONS);
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "0");
    const disabled = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), OPTIONS);
    for (const generated of [enabled, disabled]) {
      const projection = generated.multiPreparedProgramAudit?.bodyPlan.moduleInitCensus;
      expect(projection?.schema).toBe("multi-prepared-module-init-census-projection-v1");
      expect(projection?.sourcePlans).toHaveLength(2);
      expect(projection?.sourcePlans.some((source) => source.plan.evaluations.length > 0)).toBe(true);
      expect(projection?.sourcePlans.some((source) => !source.executable)).toBe(true);
      expect(projection?.parityObserved).toBe(true);
      expect(Object.isFrozen(projection)).toBe(true);
      expect(Object.isFrozen(projection?.sourcePlans)).toBe(true);
    }
    expect(enabled.multiPreparedProgramAudit?.moduleInitCensus).toBe(
      enabled.multiPreparedProgramAudit?.bodyPlan.moduleInitCensus,
    );
    expect(disabled.multiPreparedProgramAudit?.moduleInitCensus).toBe(
      disabled.multiPreparedProgramAudit?.bodyPlan.moduleInitCensus,
    );
    expect(projectMultiPreparedModuleInitCensus).toBeDefined();
  });
});
