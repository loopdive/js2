// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource, type MultiTypedAST } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateMultiModule, type GeneratedCodegenModule } from "../src/codegen/index.js";
import {
  MultiPreparedProgramOwner,
  type MultiPreparedProgramInvariantCode,
} from "../src/codegen/multi-prepared-program.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  buildIrUnitInventory,
  type IrSourceId,
  type IrTerminalUnitRecord,
  type IrUnitInventory,
  type IrUnitId,
} from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { IrInvariantError } from "../src/ir/outcomes.js";
import { createEmptyModule, type WasmModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import type { CodegenContext, CodegenOptions } from "../src/codegen/context/types.js";
import type {
  EarlyMultiPreparedScalarLeafState,
  MultiPreparedScalarLeafPlan,
} from "../src/codegen/multi-prepared-scalar-leaf.js";

// Register the low-level codegen delegates used by generateMultiModule.
import "../src/codegen/expressions.js";

const OPTIONS: CodegenOptions = {
  experimentalIR: true,
  target: "standalone",
  trackIrOutcomes: true,
};

const EMPTY_FILES = {
  "./dep.ts": `export interface DepMarker { readonly tag: "dep"; }`,
  "./entry.ts": `import type { DepMarker } from "./dep"; export type EntryMarker = DepMarker;`,
} as const;

const SAME_NAME_FILES = {
  "./dep.ts": `export function same(): number { return 1; }`,
  "./entry.ts": `
    import { same as importedSame } from "./dep";
    export function same(): number { return 2; }
    export function callImported(): number { return importedSame(); }
  `,
} as const;

interface OwnerFixture {
  readonly ast: MultiTypedAST;
  readonly inventory: IrUnitInventory;
  readonly identity: IrPlanningIdentityContext;
  readonly module: WasmModule;
  readonly session: ProgramAbiSession;
  readonly ctx: CodegenContext;
}

function ownerFixture(files: Record<string, string> = EMPTY_FILES): OwnerFixture {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, OPTIONS, session, identity);
  return { ast, inventory, identity, module, session, ctx };
}

function ownerFor(fixture: OwnerFixture, ast: MultiTypedAST = fixture.ast): MultiPreparedProgramOwner {
  return new MultiPreparedProgramOwner({
    multiAst: ast,
    identityContext: fixture.identity,
    programAbiSession: fixture.session,
    ctx: fixture.ctx,
    overlayEnabled: false,
  });
}

function variantFixture(
  fixture: OwnerFixture,
  inventory: IrUnitInventory,
  identityChanges: Partial<IrPlanningIdentityContext> = {},
): OwnerFixture {
  const identity = Object.freeze({ ...fixture.identity, inventory, ...identityChanges }) as IrPlanningIdentityContext;
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, fixture.ast.checker, OPTIONS, session, identity);
  return { ...fixture, identity, module, session, ctx };
}

function expectInvariant(action: () => unknown, code: MultiPreparedProgramInvariantCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrInvariantError);
  expect(caught).toMatchObject({
    code: "selection-preparation-mismatch",
    multiPreparedProgramCode: code,
  });
}

function fakePlan(identity: IrPlanningIdentityContext): MultiPreparedScalarLeafPlan {
  return {
    identityPlan: { identityContext: identity } as MultiPreparedScalarLeafPlan["identityPlan"],
    functionClaimsByUnitId: new Map(),
    overrideMapByUnitId: new Map(),
    overrideMap: new Map(),
    classShapes: new Map(),
    classShapesById: new Map(),
  };
}

function emptyState(
  identity: IrPlanningIdentityContext,
): EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan> {
  return { plan: fakePlan(identity), skippedFunctionUnitIds: new Set() };
}

function routeMaps(
  entries: readonly (readonly [ts.SourceFile, EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan>])[],
): {
  readonly scalar: () => ReadonlyMap<ts.SourceFile, EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan>>;
  readonly array: () => ReadonlyMap<ts.SourceFile, EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan>>;
  readonly functionValue: () => ReadonlyMap<
    ts.SourceFile,
    EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan>
  >;
  readonly fibonacciPair: () => ReadonlyMap<
    ts.SourceFile,
    EarlyMultiPreparedScalarLeafState<MultiPreparedScalarLeafPlan>
  >;
} {
  return {
    scalar: () => new Map(entries),
    array: () => new Map(),
    functionValue: () => new Map(),
    fibonacciPair: () => new Map(),
  };
}

function sourceIdFor(fixture: OwnerFixture, sourceFile: ts.SourceFile): IrSourceId {
  const sourceId = fixture.identity.sourceIdBySourceFile.get(sourceFile);
  if (!sourceId) throw new Error(`missing source identity for ${sourceFile.fileName}`);
  return sourceId;
}

function terminalWithDeclaration(fixture: OwnerFixture): IrTerminalUnitRecord {
  const terminal = fixture.inventory.terminalUnits.find((candidate) =>
    fixture.identity.declarationByUnitId.has(candidate.id),
  );
  if (!terminal) throw new Error("missing declaration-backed terminal fixture");
  return terminal;
}

function generatedRoute(
  files: Record<string, string>,
  entryFile: string,
  cutover: string,
  required: string,
  routeKind: "scalar" | "array" | "function-value" | "fibonacci-pair",
): GeneratedCodegenModule {
  vi.stubEnv(cutover, "1");
  vi.stubEnv(required, "1");
  const generated = generateMultiModule(analyzeMultiSource(files, entryFile), OPTIONS);
  expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  const audit = generated.multiPreparedProgramAudit;
  expect(audit).toBeDefined();
  expect(audit?.bodyPlan.reservations).toHaveLength(routeKind === "fibonacci-pair" ? 2 : 1);
  expect(new Set(audit?.bodyPlan.reservations.map((reservation) => reservation.routeKind))).toEqual(
    new Set([routeKind]),
  );
  expect(audit?.bodyPlan.reservations.every((reservation) => reservation.preparedBeforeDirectBodies)).toBe(true);
  expect(audit?.bodySourceIds).toEqual(audit?.bodyPlan.semanticSourceIds);
  expect(audit?.overlaySourceIds).toEqual(audit?.bodyPlan.semanticSourceIds);
  expect(Object.isFrozen(audit)).toBe(true);
  expect(Object.isFrozen(audit?.bodyPlan)).toBe(true);
  expect(Object.isFrozen(audit?.bodyPlan.sources)).toBe(true);
  expect(Object.isFrozen(audit?.bodyPlan.reservations)).toBe(true);
  expect(audit?.bodyPlan.reservations.every((reservation) => Object.isFrozen(reservation))).toBe(true);
  expect(audit?.abiSessionBound).toBe(true);
  return generated;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3525 whole-program Prepared ownership census", () => {
  it("freezes the exact denominator and separates canonical from semantic order", () => {
    const fixture = ownerFixture();
    const owner = ownerFor(fixture);
    const plan = owner.sealBodyBoundary();

    expect(owner.state).toBe("body-boundary-sealed");
    expect(plan.schema).toBe("multi-prepared-program-body-plan-v1");
    expect(plan.entrySourceId).toBe(sourceIdFor(fixture, fixture.ast.entryFile));
    expect(plan.canonicalSourceIds).toEqual(fixture.inventory.sources.map((source) => source.id));
    expect(plan.semanticSourceIds).toEqual(fixture.ast.sourceFiles.map((source) => sourceIdFor(fixture, source)));
    expect(plan.expectedBodySourceIds).toEqual(plan.semanticSourceIds);
    expect(plan.expectedOverlaySourceIds).toEqual([]);
    expect(plan.terminalUnitIds).toEqual(fixture.inventory.terminalUnits.map((unit) => unit.id));
    expect(plan.reservations).toEqual([]);
    expect(plan.unreservedTerminalUnitIds).toEqual(plan.terminalUnitIds);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.canonicalSourceIds)).toBe(true);
    expect(Object.isFrozen(plan.semanticSourceIds)).toBe(true);
    expect(Object.isFrozen(plan.sources)).toBe(true);
    expect(Object.isFrozen(plan.reservations)).toBe(true);
  });

  it("keeps same-labelled source functions distinct and ignores route-map insertion order", () => {
    const fixture = ownerFixture(SAME_NAME_FILES);
    const same = fixture.inventory.terminalUnits.filter((unit) => unit.displayName === "same");
    expect(same).toHaveLength(2);
    expect(new Set(same.map((unit) => unit.sourceId)).size).toBe(2);
    expect(new Set(same.map((unit) => unit.id)).size).toBe(2);

    const entries = fixture.ast.sourceFiles.map((sourceFile) => [sourceFile, emptyState(fixture.identity)] as const);
    const forward = ownerFor(fixture);
    forward.planEarlyRoutes(routeMaps(entries));
    const forwardPlan = forward.sealBodyBoundary();
    const reverse = ownerFor(fixture);
    reverse.planEarlyRoutes(routeMaps([...entries].reverse()));
    const reversePlan = reverse.sealBodyBoundary();
    expect(reversePlan.canonicalSourceIds).toEqual(forwardPlan.canonicalSourceIds);
    expect(reversePlan.semanticSourceIds).toEqual(forwardPlan.semanticSourceIds);
    expect(reversePlan.terminalUnitIds).toEqual(forwardPlan.terminalUnitIds);
    expect(reversePlan.reservations).toEqual(forwardPlan.reservations);
  });

  it.each([
    [
      "missing source join",
      (fixture: OwnerFixture) => {
        const map = new Map(fixture.identity.sourceIdBySourceFile);
        map.delete(fixture.ast.sourceFiles[0]!);
        return variantFixture(fixture, fixture.inventory, { sourceIdBySourceFile: map });
      },
      "construction-source-join",
    ],
    [
      "duplicate source join",
      (fixture: OwnerFixture) => {
        const map = new Map(fixture.identity.sourceIdBySourceFile);
        const first = fixture.ast.sourceFiles[0]!;
        const second = fixture.ast.sourceFiles[1]!;
        map.set(second, map.get(first)!);
        return variantFixture(fixture, fixture.inventory, { sourceIdBySourceFile: map });
      },
      "construction-source-join",
    ],
    [
      "reordered canonical source records",
      (fixture: OwnerFixture) => {
        const inventory = Object.freeze({
          ...fixture.inventory,
          sources: Object.freeze([...fixture.inventory.sources].reverse()),
        }) as IrUnitInventory;
        return variantFixture(fixture, inventory);
      },
      "construction-canonical-order",
    ],
    [
      "missing canonical source record",
      (fixture: OwnerFixture) => {
        const inventory = Object.freeze({
          ...fixture.inventory,
          sources: Object.freeze(fixture.inventory.sources.slice(0, -1)),
        }) as IrUnitInventory;
        return variantFixture(fixture, inventory);
      },
      "construction-source-count",
    ],
  ] as const)("fails closed for %s", (_label, makeVariant, code) => {
    const fixture = ownerFixture();
    const variant = makeVariant(fixture);
    expectInvariant(() => ownerFor(variant), code);
  });

  it("fails closed for foreign entry/source objects and malformed terminal denominators", () => {
    const fixture = ownerFixture(SAME_NAME_FILES);
    const foreign = ts.createSourceFile(
      "/foreign.ts",
      "export interface Foreign {}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expectInvariant(
      () => ownerFor(fixture, { ...fixture.ast, sourceFiles: [foreign, ...fixture.ast.sourceFiles.slice(1)] }),
      "construction-source-join",
    );
    expectInvariant(
      () => ownerFor(fixture, { ...fixture.ast, entryFile: fixture.ast.sourceFiles[0]! }),
      "construction-entry-source",
    );
    expectInvariant(() => ownerFor(fixture, { ...fixture.ast, entryFile: foreign }), "construction-source-join");

    const duplicateInventory = Object.freeze({
      ...fixture.inventory,
      terminalUnits: Object.freeze([...fixture.inventory.terminalUnits, fixture.inventory.terminalUnits[0]!]),
    }) as IrUnitInventory;
    expectInvariant(() => ownerFor(variantFixture(fixture, duplicateInventory)), "construction-terminal-denominator");

    const foreignTerminal = Object.freeze({
      ...fixture.inventory.terminalUnits[0]!,
      id: "ir-unit:foreign-terminal" as IrUnitId,
    }) as IrTerminalUnitRecord;
    const unknownInventory = Object.freeze({
      ...fixture.inventory,
      terminalUnits: Object.freeze([...fixture.inventory.terminalUnits, foreignTerminal]),
    }) as IrUnitInventory;
    expectInvariant(() => ownerFor(variantFixture(fixture, unknownInventory)), "construction-terminal-denominator");

    const declaredTerminal = terminalWithDeclaration(fixture);
    const otherSource = fixture.inventory.sources.find((source) => source.id !== declaredTerminal.sourceId);
    if (!otherSource) throw new Error("missing second source for terminal mutation");
    const wrongTerminal = Object.freeze({ ...declaredTerminal, sourceId: otherSource.id });
    const wrongAllUnits = fixture.inventory.allUnits.map((unit) => (unit === declaredTerminal ? wrongTerminal : unit));
    const wrongInventory = Object.freeze({
      ...fixture.inventory,
      allUnits: Object.freeze(wrongAllUnits),
      terminalUnits: Object.freeze(
        fixture.inventory.terminalUnits.map((unit) => (unit === declaredTerminal ? wrongTerminal : unit)),
      ),
    }) as IrUnitInventory;
    const wrongTerminalMap = new Map(fixture.identity.terminalByUnitId);
    wrongTerminalMap.set(declaredTerminal.id, wrongTerminal);
    const wrongUnitMap = new Map(fixture.identity.unitByUnitId);
    wrongUnitMap.set(declaredTerminal.id, wrongTerminal);
    expectInvariant(
      () =>
        ownerFor(
          variantFixture(fixture, wrongInventory, {
            terminalByUnitId: wrongTerminalMap,
            unitByUnitId: wrongUnitMap,
          }),
        ),
      "construction-terminal-denominator",
    );
  });

  it("rejects duplicate/foreign route states before any body consumer runs", () => {
    const fixture = ownerFixture();
    const [first, second] = fixture.ast.sourceFiles;
    if (!first || !second) throw new Error("missing two-source fixture");
    const state = emptyState(fixture.identity);

    const duplicate = ownerFor(fixture);
    expectInvariant(
      () =>
        duplicate.planEarlyRoutes({
          scalar: () => new Map([[first, state]]),
          array: () => new Map([[first, state]]),
          functionValue: () => new Map(),
          fibonacciPair: () => new Map(),
        }),
      "duplicate-route-source",
    );

    const foreign = ownerFor(fixture);
    const foreignSource = ts.createSourceFile(
      "/foreign.ts",
      "export function foreign() {}",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expectInvariant(
      () =>
        foreign.planEarlyRoutes({
          scalar: () => new Map([[foreignSource, state]]),
          array: () => new Map(),
          functionValue: () => new Map(),
          fibonacciPair: () => new Map(),
        }),
      "construction-source-join",
    );

    const stalePlan = ownerFor(fixture);
    const other = ownerFixture();
    const foreignState = emptyState(other.identity);
    expectInvariant(
      () =>
        stalePlan.planEarlyRoutes({
          scalar: () => new Map([[second, foreignState]]),
          array: () => new Map(),
          functionValue: () => new Map(),
          fibonacciPair: () => new Map(),
        }),
      "route-plan-mismatch",
    );
  });

  it("enforces body/overlay phase order, completion order, and failed-closed source mutation", () => {
    const fixture = ownerFixture();
    const makePhaseOwner = (): MultiPreparedProgramOwner =>
      new MultiPreparedProgramOwner({
        multiAst: fixture.ast,
        identityContext: fixture.identity,
        programAbiSession: fixture.session,
        ctx: fixture.ctx,
        overlayEnabled: true,
      });
    const owner = makePhaseOwner();
    owner.sealBodyBoundary();
    const first = fixture.ast.sourceFiles[0]!;
    const second = fixture.ast.sourceFiles[1]!;
    expectInvariant(() => owner.compileBodySource(second, "discover"), "body-phase-order");

    const incomplete = makePhaseOwner();
    incomplete.sealBodyBoundary();
    expectInvariant(() => incomplete.sealRoutesComplete(), "routes-incomplete");

    // The empty fixture has no direct declarations, so these consumers only
    // exercise the owner's phase cursor and do not create a route-specific
    // codegen obligation.
    const overlayOutOfOrder = makePhaseOwner();
    overlayOutOfOrder.sealBodyBoundary();
    overlayOutOfOrder.compileBodySource(first, "discover");
    overlayOutOfOrder.compileBodySource(second, "full");
    expectInvariant(() => overlayOutOfOrder.withOverlayState(second, () => undefined), "overlay-phase-order");

    const completeOwner = makePhaseOwner();
    completeOwner.sealBodyBoundary();
    completeOwner.compileBodySource(first, "discover");
    completeOwner.compileBodySource(second, "full");
    completeOwner.withOverlayState(first, () => undefined);
    completeOwner.withOverlayState(second, () => undefined);
    completeOwner.sealRoutesComplete();
    const publication = fixture.session.publish(fixture.module);
    const audit = completeOwner.complete(publication);
    expect(completeOwner.state).toBe("complete");
    expect(completeOwner.complete(publication)).toBe(audit);

    const mutated = ownerFixture();
    const sealed = ownerFor(mutated);
    sealed.sealBodyBoundary();
    mutated.ast.sourceFiles.reverse();
    expectInvariant(() => sealed.sealRoutesComplete(), "construction-source-join");
  });

  it("rejects an ABI publication from another inventory", () => {
    const fixture = ownerFixture();
    const owner = new MultiPreparedProgramOwner({
      multiAst: fixture.ast,
      identityContext: fixture.identity,
      programAbiSession: fixture.session,
      ctx: fixture.ctx,
      overlayEnabled: false,
    });
    owner.sealBodyBoundary();
    owner.compileBodySource(fixture.ast.sourceFiles[0]!, "discover");
    owner.compileBodySource(fixture.ast.sourceFiles[1]!, "full");
    owner.sealRoutesComplete();
    const other = ownerFixture();
    const publication = other.session.publish(other.module);
    expectInvariant(() => owner.complete(publication), "publication-inventory-mismatch");
  });

  it("records all four existing early routes and removes only their own reservation", () => {
    const benchmarkHelpers = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
    const helperSource = readFileSync(benchmarkHelpers, "utf8");
    const cases = [
      {
        files: {
          "./dep.ts": `export interface Marker { readonly tag: "marker"; }`,
          "./entry.ts": `import type { Marker } from "./dep"; type Keep = Marker; export function entryPure(x: number): number { return x + 4; }`,
        },
        entryFile: "./entry.ts",
        cutover: "JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER",
        required: "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_SCALAR_LEAF",
        routeKind: "scalar" as const,
      },
      {
        files: {
          "./helpers.ts": helperSource,
          "./loop.ts": readFileSync(
            resolve(import.meta.dirname, "../website/playground/examples/benchmarks/loop.ts"),
            "utf8",
          ),
        },
        entryFile: "./loop.ts",
        cutover: "JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER",
        required: "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_BENCH_LOOP",
        routeKind: "function-value" as const,
      },
      {
        files: {
          "./helpers.ts": helperSource,
          "./fib.ts": readFileSync(
            resolve(import.meta.dirname, "../website/playground/examples/benchmarks/fib.ts"),
            "utf8",
          ),
        },
        entryFile: "./fib.ts",
        cutover: "JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER",
        required: "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_FIB_PAIR",
        routeKind: "fibonacci-pair" as const,
      },
      {
        files: {
          "./helpers.ts": helperSource,
          "./array.ts": readFileSync(
            resolve(import.meta.dirname, "../website/playground/examples/benchmarks/array.ts"),
            "utf8",
          ),
        },
        entryFile: "./array.ts",
        cutover: "JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER",
        required: "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_ARRAY_LEAF",
        routeKind: "array" as const,
      },
    ];

    for (const testCase of cases) {
      vi.unstubAllEnvs();
      const prepared = generatedRoute(
        testCase.files,
        testCase.entryFile,
        testCase.cutover,
        testCase.required,
        testCase.routeKind,
      );
      const preparedAudit = prepared.multiPreparedProgramAudit!;
      vi.unstubAllEnvs();
      vi.stubEnv(testCase.cutover, "0");
      const direct = generateMultiModule(analyzeMultiSource(testCase.files, testCase.entryFile), OPTIONS);
      expect(direct.errors.filter((error) => error.severity !== "warning")).toEqual([]);
      expect(direct.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds).toEqual(
        preparedAudit.bodyPlan.terminalUnitIds,
      );
      expect(direct.multiPreparedProgramAudit?.bodyPlan.sources).toEqual(preparedAudit.bodyPlan.sources);
      expect(direct.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
      expect(direct.multiPreparedProgramAudit?.bodySourceIds).toEqual(preparedAudit.bodySourceIds);
      expect(direct.multiPreparedProgramAudit?.overlaySourceIds).toEqual(preparedAudit.overlaySourceIds);
    }
  }, 120_000);

  it("completes a non-candidate multi-source graph with exact visits and no reservation", () => {
    const fixture = ownerFixture(SAME_NAME_FILES);
    const generated = generateMultiModule(analyzeMultiSource(SAME_NAME_FILES, "./entry.ts"), OPTIONS);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit;
    expect(audit).toBeDefined();
    expect(audit?.bodyPlan.reservations).toEqual([]);
    expect(audit?.bodyPlan.terminalUnitIds).toEqual(fixture.inventory.terminalUnits.map((unit) => unit.id));
    expect(audit?.bodySourceIds).toEqual(audit?.bodyPlan.semanticSourceIds);
    expect(audit?.overlaySourceIds).toEqual(audit?.bodyPlan.semanticSourceIds);
  });
});
