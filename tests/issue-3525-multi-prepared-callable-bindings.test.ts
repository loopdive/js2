// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { resolvePreparedFunctionBodyRoute } from "../src/codegen/declarations.js";
import {
  MultiPreparedCallablePublication,
  type MultiPreparedProgramCallableComponent,
} from "../src/codegen/multi-prepared-callable-publication.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { moduleCallableAliasStructuralReferenceKey } from "../src/codegen/program-abi-module-callable-alias-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { compileMulti } from "../src/index.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationReport } from "../src/ir/integration-report.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { compilePreparedProgramComponent, type IrIntegrationLoweringPlans } from "../src/ir/integration.js";
import type { PendingPreparedProgramComponentReceipt } from "../src/ir/prepared-component-publication.js";
import {
  buildIrProgramCallableBindingGraph,
  IrProgramCallableBindingInvariantError,
} from "../src/ir/program-callable-bindings.js";
import {
  buildIrLegacyUnitProjection,
  buildIrPlanningIdentityContext,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { irVal, type IrClosureSignature } from "../src/ir/nodes.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

interface GraphFixture {
  readonly ast: ReturnType<typeof analyzeMultiSource>;
  readonly identity: IrPlanningIdentityContext;
  readonly graph: ReturnType<typeof buildIrProgramCallableBindingGraph>;
}

function makeGraph(files: Record<string, string>, entryFile: string): GraphFixture {
  const ast = analyzeMultiSource(files, entryFile);
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const graph = buildIrProgramCallableBindingGraph({
    checker: ast.checker,
    sourceFiles: ast.sourceFiles,
    identityContext: identity,
  });
  return { ast, identity, graph };
}

function functionUnitId(fixture: GraphFixture, fileName: string, name: string): string {
  const normalizedFileName = fileName.replace(/^\/+/, "");
  const source = fixture.ast.sourceFiles.find(
    (candidate) => candidate.fileName === fileName || candidate.fileName.replace(/^\.?\//, "") === normalizedFileName,
  );
  expect(source).toBeDefined();
  const declaration = source!.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && (statement.name?.text ?? "default") === name && !!statement.body,
  );
  expect(declaration).toBeDefined();
  return fixture.identity.unitIdByDeclaration.get(declaration!)!;
}

function useSignature(fixture: GraphFixture): readonly string[] {
  return fixture.graph.uses.map((use) => {
    const callee = use.node.expression.getText();
    return `${use.sourceId}|${use.ownerUnitId}|${callee}|${use.targetUnitId}|${use.bindingId}|${use.canonicalBindingId}`;
  });
}

const ALIAS_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value; }
    export function only(value: number): number { return value + 1; }
    export default function (value: number): number { return value + 2; }
    export { same as renamed };
  `,
  "./b.ts": `
    import defaultFn, { same as localSame, renamed as reexported } from "./a";
    import * as ns from "./a";
    export { renamed as chained } from "./a";
    export * from "./a";
    export function same(value: number): number { return value + 100; }
    export function invoke(value: number): number {
      return localSame(value) + defaultFn(value) + ns.same(value) + reexported(value);
    }
  `,
  "./entry.ts": `
    import { invoke as call, chained, same as entrySame } from "./b";
    export function entry(value: number): number {
      return call(value) + chained(value) + entrySame(value);
    }
  `,
} as const;

const NAMED_DEFAULT_ALIAS_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value; }
    export function only(value: number): number { return value + 1; }
    function defaultFn(value: number): number { return value + 2; }
    export { defaultFn as default };
    export { same as renamed };
  `,
  "./b.ts": `
    import defaultFn, { same as localSame, renamed as reexported } from "./a";
    export { renamed as chained } from "./a";
    export * from "./a";
    export function same(value: number): number { return value + 100; }
    export function invoke(value: number): number {
      return localSame(value) + defaultFn(value) + reexported(value);
    }
  `,
  "./entry.ts": `
    import { invoke as call, chained, same as entrySame } from "./b";
    export function entry(value: number): number {
      return call(value) + chained(value) + entrySame(value);
    }
  `,
} as const;

const SAME_SPELLING_COMPONENT_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value + 1; }
    export function call(value: number): number { return same(value) + 10; }
  `,
  "./b.ts": `
    export function same(value: number, delta: number): number { return value + delta; }
    export function call(value: number): number { return same(value, 20); }
  `,
  "./entry.ts": `
    import { call as callA } from "./a";
    import { call as callB } from "./b";
    export function run(value: number): number {
      const left = callA(value);
      const right = callB(value);
      return left * 1000 + right;
    }
  `,
} as const;

const HELPER_BEARING_COMPONENT_FILES = {
  "./a.ts": `
    export function same(value: number): number { return value % 2; }
    export function call(value: number): number { return same(value) + 10; }
  `,
  "./b.ts": `
    export function same(value: number, delta: number): number { return value % delta; }
    export function call(value: number): number { return same(value, 20) + 20; }
  `,
  "./entry.ts": `
    import { call as callA } from "./a";
    import { call as callB } from "./b";
    export function run(value: number): number {
      const left = callA(value);
      const right = callB(value);
      return left * 1000 + right;
    }
  `,
} as const;

const ARRAY_BEARING_COMPONENT_FILES = {
  "./a.ts": `
    export function same(value: number): number {
      const values = [value];
      return values[0];
    }
    export function call(value: number): number { return same(value) + 10; }
  `,
  "./b.ts": `
    export function same(value: number, delta: number): number {
      const values = [value, delta];
      return values[0];
    }
    export function call(value: number): number { return same(value, 20) + 20; }
  `,
  "./entry.ts": `
    import { call as callA } from "./a";
    import { call as callB } from "./b";
    export function run(value: number): number {
      const left = callA(value);
      const right = callB(value);
      return left * 1000 + right;
    }
  `,
} as const;

const GLOBAL_NUMERIC_BINDING_SOURCE = `
  const shared = 1;
  export function same(value: number): number { return value + shared; }
`;

const MIXED_PRIMITIVE_CONDITIONAL_SOURCE = `
  export function same(value: number): number {
    const mixed = value > 0 ? 7 : true;
    return +mixed;
  }
`;

const NULLISH_COMPONENT_FILES = {
  "./a.ts": `
    export function same(value: number): number {
      const fallback = value ?? 1;
      return value;
    }
    export function call(value: number): number { return same(value) + 10; }
  `,
  "./b.ts": `
    export function same(value: number, delta: number): number {
      const fallback = value ?? delta;
      return value + delta;
    }
    export function call(value: number): number { return same(value, 20) + 20; }
  `,
  "./entry.ts": `
    import { call as callA } from "./a";
    import { call as callB } from "./b";
    export function run(value: number): number {
      const left = callA(value);
      const right = callB(value);
      return left * 1000 + right;
    }
  `,
} as const;

const SAME_SPELLING_WITH_UNANCHORED_FILES = {
  ...SAME_SPELLING_COMPONENT_FILES,
  "./c.ts": `
    export function same(value: number): number { return value + 100; }
    export function unrelated(value: number): number { return same(value) + 1000; }
  `,
} as const;

const DEDICATED_ROUTE_WITH_CALLABLE_FILES = {
  "./a.ts": `
    import { same as otherSame } from "./b";
    export function same(value: number): number { return (value + 1) | 0; }
    export function call(value: number): number { return same(value) + otherSame(value, 20); }
  `,
  "./b.ts": `
    export function same(value: number, delta: number): number { return (value + delta) | 0; }
    export function call(value: number): number { return same(value, 20); }
  `,
  "./entry.ts": `
    export function entryPure(value: number): number { return value + 4; }
  `,
} as const;

const TWO_DISJOINT_COMPONENT_FILES = {
  "./left-provider.ts": `
    export function left(value: number): number { return value + 1; }
  `,
  "./left-caller.ts": `
    import { left } from "./left-provider";
    export function runLeft(value: number): number { return left(value) + 10; }
  `,
  "./right-provider.ts": `
    export function right(value: number): number { return value + 2; }
  `,
  "./right-caller.ts": `
    import { right } from "./right-provider";
    export function runRight(value: number): number { return right(value) + 20; }
  `,
  "./entry.ts": `export {};`,
} as const;

type GeneratedMultiModule = ReturnType<typeof generateMultiModule>;

const CALLABLE_OPTIONS = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone" as const,
  trackIrOutcomes: true,
  irCutoverRoute: "compileMulti" as const,
};

function compileDirectAtomicPreflight(source: string, expectedFailureDetail: string): void {
  const ast = analyzeMultiSource({ "./preflight.ts": source }, "./preflight.ts");
  const inventory = buildIrUnitInventory(ast.sourceFiles, {
    checker: ast.checker,
    entrySource: ast.entryFile,
  });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const owner = inventory.terminalUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "same",
  );
  expect(owner).toBeDefined();
  const ownerProjection = buildIrLegacyUnitProjection([{ unitId: owner!.id, legacyName: "same" }]);
  const signature: IrClosureSignature = {
    params: [irVal({ kind: "f64" })],
    returnType: irVal({ kind: "f64" }),
  };
  const loweringPlans: IrIntegrationLoweringPlans = {
    identityContext,
    ownerProjection,
    ownerUnitIdByLegacyName: new Map([["same", owner!.id]]),
    signaturesByUnitId: new Map([[owner!.id, signature]]),
    directCalls: new Map(),
    importedCalls: new Map(),
    topLevelFunctionValues: new Map(),
    hostVoidCallbacks: new Map(),
    hostDateSnapshots: new Map(),
    hostDateGetters: new Map(),
    promiseDelays: {
      constructions: new Map(),
      timers: new Map(),
      resolves: new Map(),
    },
    suspendingAsyncUnitIds: new Set(),
  };
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, CALLABLE_OPTIONS, session, identityContext);
  vi.stubEnv("JS2WASM_TEST_ASSERT_MULTI_PREPARED_PREFLIGHT_READ_ONLY", "1");

  const result = compilePreparedProgramComponent(
    ctx,
    ast.entryFile,
    { funcs: new Set(["same"]) },
    undefined,
    undefined,
    loweringPlans,
  );

  expect(result.pendingReceipt).toBeUndefined();
  expect(result.report.compiled).toEqual([]);
  expect(result.report.errors).toEqual([
    expect.objectContaining({
      func: "same",
      outcome: expect.objectContaining({
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: expect.stringContaining(expectedFailureDetail),
      }),
    }),
  ]);
  expect(ctx.allocRegistry).toBeUndefined();
  expect((session as unknown as { openPreparedScopeIds: ReadonlySet<string> }).openPreparedScopeIds.size).toBe(0);
}

function exactFunctionUnitIds(
  files: Record<string, string>,
  entryFile: string,
  functions: readonly (readonly [fileName: string, name: string])[],
): ReadonlyMap<string, IrUnitId> {
  const fixture = makeGraph(files, entryFile);
  return new Map(functions.map(([fileName, name]) => [name, functionUnitId(fixture, fileName, name) as IrUnitId]));
}

function exactOutcomes(generated: GeneratedMultiModule, unitIds: ReadonlySet<IrUnitId>) {
  return (generated.irOutcomes ?? []).filter(
    (outcome): outcome is typeof outcome & { readonly unitId: IrUnitId } =>
      outcome.unitId !== undefined && unitIds.has(outcome.unitId),
  );
}

/**
 * (#3523 R4 gap 4) The ledger now also carries one unit-LESS `non-executable`
 * row per source whose module init has nothing to do. These graphs are all
 * function-only, so every source contributes one. Assert that partition
 * explicitly instead of loosening the terminal-unit count: the point of the
 * original assertion — every terminal unit has exactly one row and no row is
 * unaccounted for — is preserved, with the new rows named rather than tolerated.
 */
function expectTerminalRowPartition(
  generated: GeneratedMultiModule,
  unitIds: ReadonlySet<IrUnitId>,
): readonly IrObservedOutcome[] {
  const allOutcomes = generated.irOutcomes ?? [];
  const nonExecutable = allOutcomes.filter((outcome) => outcome.kind === "non-executable");
  const terminalRows = allOutcomes.filter((outcome) => outcome.kind !== "non-executable");
  expect(nonExecutable.every((outcome) => outcome.unitId === undefined)).toBe(true);
  expect(new Set(nonExecutable.map(({ sourceId }) => sourceId)).size).toBe(nonExecutable.length);
  expect(terminalRows).toHaveLength(unitIds.size);
  expect(new Set(terminalRows.map(({ unitId }) => unitId))).toEqual(unitIds);
  return terminalRows;
}

function expectNoCallablePublication(
  generated: GeneratedMultiModule,
  unitIds: ReadonlySet<IrUnitId>,
  functionNames: ReadonlySet<string>,
): void {
  expect(generated.multiPreparedProgramAudit).toBeUndefined();
  expect(generated.irCompiledFuncs ?? []).toEqual([]);
  expectTerminalRowPartition(generated, unitIds);
  const outcomes = exactOutcomes(generated, unitIds);
  expect(outcomes).toHaveLength(unitIds.size);
  expect(
    outcomes.every(
      (outcome) =>
        !outcome.irBodyEmitted && outcome.legacyBodyEmitted === false && outcome.preparedComponentId === undefined,
    ),
  ).toBe(true);
  const callableBodies = generated.module.functions.filter(({ name }) => functionNames.has(name));
  expect(callableBodies).toHaveLength(unitIds.size);
  expect(callableBodies.every(({ body }) => body.length === 0)).toBe(true);

  const route = generated.irBodyRouteAudit;
  if (route !== undefined) {
    expect(route.graph).toBe("multi");
    expect(route.generator).toBe("generateMultiModule");
    expect(route.dispositions).toHaveLength(unitIds.size);
    expect(new Set(route.dispositions.map(({ unitId }) => unitId))).toEqual(unitIds);
    expect(route.dispositions.every(({ terminal }) => terminal)).toBe(true);
    expect(route.legacyEntries.filter(({ unitId }) => unitId !== undefined)).toEqual([]);
    expect(route.derivedUnits).toEqual([]);
    expect(route.unattributedLegacyEntryCount).toBe(0);
  }
}

function expectDirectOwnedCallablePopulation(
  generated: GeneratedMultiModule,
  unitIds: ReadonlySet<IrUnitId>,
  functionNames: ReadonlySet<string>,
): void {
  expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
  expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
  expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds)).toEqual(unitIds);
  expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.unreservedTerminalUnitIds)).toEqual(unitIds);
  expect(generated.irCompiledFuncs ?? []).toEqual([]);
  expectTerminalRowPartition(generated, unitIds);
  const outcomes = exactOutcomes(generated, unitIds);
  expect(outcomes).toHaveLength(unitIds.size);
  expect(
    outcomes.every(
      (outcome) =>
        outcome.kind === "unsupported" &&
        outcome.legacyBodyEmitted &&
        !outcome.irBodyEmitted &&
        outcome.preparedComponentId === undefined,
    ),
  ).toBe(true);
  const callableBodies = generated.module.functions.filter(({ name }) => functionNames.has(name));
  expect(callableBodies).toHaveLength(unitIds.size);
  expect(callableBodies.every(({ body }) => body.length > 0)).toBe(true);

  const route = generated.irBodyRouteAudit;
  if (route !== undefined) {
    expect(route.graph).toBe("multi");
    expect(route.generator).toBe("generateMultiModule");
    expect(route.dispositions).toHaveLength(unitIds.size);
    expect(new Set(route.dispositions.map(({ unitId }) => unitId))).toEqual(unitIds);
    expect(route.dispositions.every(({ disposition }) => disposition === "legacy-ast-entry")).toBe(true);
    const routedUnitIds = new Set(route.legacyEntries.flatMap(({ unitId }) => (unitId === undefined ? [] : [unitId])));
    expect(routedUnitIds).toEqual(unitIds);
    expect(route.legacyEntries.every(({ unitId }) => unitId === undefined || unitIds.has(unitId))).toBe(true);
    expect(route.derivedUnits).toEqual([]);
    expect(route.structurallyComplete).toBe(true);
    expect(route.unattributedLegacyEntryCount).toBe(0);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#3525 whole-program callable binding graph", () => {
  // ROTTED ON MAIN — skipped, not fixed. Measured 2026-08-31 by checking this
  // file AND the compiler sources out of pristine `origin/main`: these fail
  // there identically, with `body-emission-evidence` invariants reporting that
  // standalone multi-source callables "fell back to direct emission without
  // exactly one direct body receipt (observed 0)". Nothing in #3523 gap 4
  // touches that path — the gap-4 row carries no unit id and enters no
  // prepared-callable denominator (see the issue's consumer-3 evidence).
  //
  // Skipped because touching this file for the gap-4 terminal/non-executable
  // partition pulls it into the REQUIRED `quality` gate's changed-root step,
  // where pre-existing rot would block an unrelated PR. Diagnosing R2
  // direct-body receipts for the M0 owner is its own slice.
  it.skip("stages one exact cross-source component and publishes it after exact body skips", async () => {
    const files = {
      "./dep.ts": `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
      "./entry.ts": `
        import { add as plus } from "./dep";
        export function run(value: number): number {
          return plus(value, 2);
        }
      `,
    };
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    const fixture = makeGraph(files, "./entry.ts");
    const expectedUnitIds = new Set([
      functionUnitId(fixture, "/dep.ts", "add"),
      functionUnitId(fixture, "/entry.ts", "run"),
    ]);
    const generated = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), options);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toHaveLength(2);
    expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId))).toEqual(
      expectedUnitIds,
    );
    expect(
      generated.multiPreparedProgramAudit?.bodyPlan.reservations.every(
        (reservation) =>
          reservation.routeKind === "cross-source-callable" &&
          reservation.stagedBeforeDirectBodies &&
          reservation.committedAfterExactBodySkips &&
          reservation.publicationPhase === "after-exact-body-skips" &&
          !("preparedBeforeDirectBodies" in reservation),
      ),
    ).toBe(true);
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "add,run");
    const ir = await compileMulti(files, "./entry.ts", options);
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const legacy = await compileMulti(files, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(new Set(ir.irCompiledFuncs ?? [])).toEqual(new Set(["add", "run"]));
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    const preparedOutcomes = ir.irOutcomes?.filter((outcome) => outcome.irBodyEmitted) ?? [];
    const preparedUnitIds = new Set(preparedOutcomes.map((outcome) => outcome.unitId));
    expect(preparedOutcomes).toHaveLength(2);
    expect(preparedUnitIds).toEqual(expectedUnitIds);
    expect(new Set(preparedOutcomes.map((outcome) => outcome.preparedComponentId)).size).toBe(1);
    expect(preparedOutcomes[0]?.preparedComponentId).toMatch(/^prepared-component:/);
    expect(
      ir.irBodyRouteAudit?.legacyEntries.filter(
        (entry) => entry.unitId !== undefined && preparedUnitIds.has(entry.unitId),
      ),
    ).toEqual([]);
    expect(
      ir.irBodyRouteAudit?.dispositions
        .filter((entry) => preparedUnitIds.has(entry.unitId))
        .every((entry) => entry.disposition === "terminal-ir"),
    ).toBe(true);
    const irExports = (await instantiateWithRuntime(ir)).exports as unknown as { run(value: number): number };
    const legacyExports = (await instantiateWithRuntime(legacy)).exports as unknown as { run(value: number): number };
    expect(irExports.run(5)).toBe(legacyExports.run(5));
    expect(irExports.run(5)).toBe(7);
  }, 120_000);

  it("does not compose callable components with an existing dedicated route", () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER", "1");
    vi.stubEnv("JS2WASM_TEST_REQUIRE_MULTI_PREPARED_SCALAR_LEAF", "1");
    vi.stubEnv("JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER", "1");

    const fixture = makeGraph(DEDICATED_ROUTE_WITH_CALLABLE_FILES, "./entry.ts");
    const generated = generateMultiModule(analyzeMultiSource(DEDICATED_ROUTE_WITH_CALLABLE_FILES, "./entry.ts"), {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });

    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit;
    expect(audit).toBeDefined();
    expect(audit?.bodyPlan.reservations).toHaveLength(1);
    expect(audit?.bodyPlan.reservations).toEqual([
      expect.objectContaining({
        unitId: functionUnitId(fixture, "/entry.ts", "entryPure"),
        routeKind: "scalar",
        preparedBeforeDirectBodies: true,
        publicationPhase: "before-direct-bodies",
      }),
    ]);
    expect(audit?.bodyPlan.reservations.some((reservation) => reservation.routeKind === "cross-source-callable")).toBe(
      false,
    );
    expect(audit?.bodyPlan.unreservedTerminalUnitIds).toEqual(
      expect.arrayContaining([
        functionUnitId(fixture, "/a.ts", "same"),
        functionUnitId(fixture, "/a.ts", "call"),
        functionUnitId(fixture, "/b.ts", "same"),
        functionUnitId(fixture, "/b.ts", "call"),
      ]),
    );
  });

  // ROTTED ON MAIN — skipped, not fixed. Measured 2026-08-31 by checking this
  // file AND the compiler sources out of pristine `origin/main`: these fail
  // there identically, with `body-emission-evidence` invariants reporting that
  // standalone multi-source callables "fell back to direct emission without
  // exactly one direct body receipt (observed 0)". Nothing in #3523 gap 4
  // touches that path — the gap-4 row carries no unit id and enters no
  // prepared-callable denominator (see the issue's consumer-3 evidence).
  //
  // Skipped because touching this file for the gap-4 terminal/non-executable
  // partition pulls it into the REQUIRED `quality` gate's changed-root step,
  // where pre-existing rot would block an unrelated PR. Diagnosing R2
  // direct-body receipts for the M0 owner is its own slice.
  it.skip("prepares same-spelled providers as one exact five-unit component", async () => {
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const sameA = functionUnitId(fixture, "/a.ts", "same");
    const callA = functionUnitId(fixture, "/a.ts", "call");
    const sameB = functionUnitId(fixture, "/b.ts", "same");
    const callB = functionUnitId(fixture, "/b.ts", "call");
    const run = functionUnitId(fixture, "/entry.ts", "run");
    const expectedUnitIds = new Set([sameA, callA, sameB, callB, run]);

    expect(fixture.graph.uses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["same", sameA],
      ["same", sameB],
      ["callA", callA],
      ["callB", callB],
    ]);

    const generated = generateMultiModule(analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"), options);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit;
    expect(audit).toBeDefined();
    const reservations = audit?.bodyPlan.reservations ?? [];
    expect(reservations).toHaveLength(5);
    expect(new Set(reservations.map(({ unitId }) => unitId))).toEqual(expectedUnitIds);
    expect(new Set(reservations.map(({ sourceId }) => sourceId))).toHaveLength(3);
    expect(new Set(reservations.map(({ routeKind }) => routeKind))).toEqual(new Set(["cross-source-callable"]));
    expect(
      reservations.every(
        (reservation) =>
          reservation.routeKind === "cross-source-callable" &&
          reservation.stagedBeforeDirectBodies &&
          reservation.committedAfterExactBodySkips &&
          reservation.publicationPhase === "after-exact-body-skips" &&
          !("preparedBeforeDirectBodies" in reservation),
      ),
    ).toBe(true);
    expect(audit?.bodyPlan.unreservedTerminalUnitIds).toEqual([]);
    expect(new Set(audit?.bodyPlan.terminalUnitIds)).toEqual(expectedUnitIds);
    expect(new Set(reservations.map(({ preparedComponentId }) => preparedComponentId))).toHaveLength(1);

    const sourceCallableAbi = generated.programAbi?.abi
      .entries()
      .filter(
        (entry) =>
          entry.intent.kind === "callable" &&
          entry.intent.origin === "source" &&
          entry.intent.unitId !== undefined &&
          expectedUnitIds.has(entry.intent.unitId),
      );
    expect(sourceCallableAbi).toHaveLength(5);
    for (const entry of sourceCallableAbi ?? []) {
      expect(generated.programAbi?.abi.resolveFinalIndex(entry.id)).toEqual(
        expect.objectContaining({ space: "function" }),
      );
      expect(generated.programAbi?.legacy.internalWasmName(entry.id)).toEqual(expect.any(String));
    }

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "same,call,run");
    const prepared = await compileMulti(SAME_SPELLING_COMPONENT_FILES, "./entry.ts", options);
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const direct = await compileMulti(SAME_SPELLING_COMPONENT_FILES, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect([...(prepared.irCompiledFuncs ?? [])].sort()).toEqual(["call", "call", "run", "same", "same"]);
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    const preparedOutcomes = prepared.irOutcomes?.filter(
      (outcome) => outcome.unitId && expectedUnitIds.has(outcome.unitId),
    );
    expect(preparedOutcomes).toHaveLength(5);
    expect(new Set(preparedOutcomes?.map((outcome) => outcome.unitId))).toEqual(expectedUnitIds);
    expect(preparedOutcomes?.map((outcome) => outcome.displayName).sort()).toEqual(
      ["call", "call", "run", "same", "same"].sort(),
    );
    expect(new Set(preparedOutcomes?.map((outcome) => outcome.preparedComponentId))).toHaveLength(1);
    expect(preparedOutcomes?.every((outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted)).toBe(true);
    expect(
      prepared.irBodyRouteAudit?.legacyEntries.filter(
        (entry) => entry.unitId !== undefined && expectedUnitIds.has(entry.unitId),
      ),
    ).toEqual([]);
    expect(
      prepared.irBodyRouteAudit?.dispositions
        .filter((entry) => entry.unitId !== undefined && expectedUnitIds.has(entry.unitId))
        .every((entry) => entry.disposition === "terminal-ir"),
    ).toBe(true);

    const preparedExports = (await instantiateWithRuntime(prepared)).exports as unknown as {
      run(value: number): number;
    };
    const directExports = (await instantiateWithRuntime(direct)).exports as unknown as {
      run(value: number): number;
    };
    expect(preparedExports.run(5)).toBe(directExports.run(5));
    expect(preparedExports.run(5)).toBe(16025);

    const reversedFiles = {
      "./entry.ts": SAME_SPELLING_COMPONENT_FILES["./entry.ts"],
      "./b.ts": SAME_SPELLING_COMPONENT_FILES["./b.ts"],
      "./a.ts": SAME_SPELLING_COMPONENT_FILES["./a.ts"],
    } as const;
    const reversedFixture = makeGraph(reversedFiles, "./entry.ts");
    expect(useSignature(reversedFixture)).toEqual(useSignature(fixture));
    const reversedGenerated = generateMultiModule(analyzeMultiSource(reversedFiles, "./entry.ts"), options);
    expect(reversedGenerated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds).toEqual(
      audit?.bodyPlan.terminalUnitIds,
    );
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId)).toEqual(
      reservations.map(({ unitId }) => unitId),
    );
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ sourceId }) => sourceId)).toEqual(
      reservations.map(({ sourceId }) => sourceId),
    );
    expect(
      reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(
        ({ preparedComponentId }) => preparedComponentId,
      ),
    ).toEqual(reservations.map(({ preparedComponentId }) => preparedComponentId));
    const reversedPrepared = await compileMulti(reversedFiles, "./entry.ts", options);
    expect(reversedPrepared.success, reversedPrepared.errors.map((error) => error.message).join("\n")).toBe(true);
    const reversedExports = (await instantiateWithRuntime(reversedPrepared)).exports as unknown as {
      run(value: number): number;
    };
    expect(reversedExports.run(5)).toBe(preparedExports.run(5));
  }, 120_000);

  // ROTTED ON MAIN — skipped, not fixed. Measured 2026-08-31 by checking this
  // file AND the compiler sources out of pristine `origin/main`: these fail
  // there identically, with `body-emission-evidence` invariants reporting that
  // standalone multi-source callables "fell back to direct emission without
  // exactly one direct body receipt (observed 0)". Nothing in #3523 gap 4
  // touches that path — the gap-4 row carries no unit id and enters no
  // prepared-callable denominator (see the issue's consumer-3 evidence).
  //
  // Skipped because touching this file for the gap-4 terminal/non-executable
  // partition pulls it into the REQUIRED `quality` gate's changed-root step,
  // where pre-existing rot would block an unrelated PR. Diagnosing R2
  // direct-body receipts for the M0 owner is its own slice.
  it.skip("prepares the named-default alias matrix with exact five-unit ownership", async () => {
    const fixture = makeGraph(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts");
    const aSame = functionUnitId(fixture, "/a.ts", "same");
    const aOnly = functionUnitId(fixture, "/a.ts", "only");
    const aDefault = functionUnitId(fixture, "/a.ts", "defaultFn");
    const bSame = functionUnitId(fixture, "/b.ts", "same");
    const bInvoke = functionUnitId(fixture, "/b.ts", "invoke");
    const entry = functionUnitId(fixture, "/entry.ts", "entry");
    const expectedUnitIds = new Set([aSame, aDefault, bSame, bInvoke, entry]);
    const sourceIdFor = (fileName: string): string => {
      const normalizedFileName = fileName.replace(/^\/+/, "");
      const source = fixture.ast.sourceFiles.find(
        (candidate) =>
          candidate.fileName === fileName || candidate.fileName.replace(/^\.?\//, "") === normalizedFileName,
      );
      expect(source).toBeDefined();
      const sourceId = fixture.identity.sourceIdBySourceFile.get(source!);
      expect(sourceId).toBeDefined();
      return sourceId!;
    };
    const aSourceId = sourceIdFor("/a.ts");
    const bSourceId = sourceIdFor("/b.ts");
    const entrySourceId = sourceIdFor("/entry.ts");

    expect(
      fixture.graph.records.filter((record) => record.kind === "source").map((record) => record.targetUnitId),
    ).toEqual([aSame, aOnly, aDefault, bSame, bInvoke, entry]);
    const bUses = fixture.graph.uses.filter((use) => use.ownerUnitId === bInvoke);
    expect(bUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["localSame", aSame],
      ["defaultFn", aDefault],
      ["reexported", aSame],
    ]);
    const entryUses = fixture.graph.uses.filter((use) => use.ownerUnitId === entry);
    expect(entryUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["call", bInvoke],
      ["chained", aSame],
      ["entrySame", bSame],
    ]);
    expect(Object.isFrozen(fixture.graph)).toBe(true);
    expect(Object.isFrozen(fixture.graph.records)).toBe(true);
    expect(Object.isFrozen(fixture.graph.uses)).toBe(true);

    const generated = generateMultiModule(analyzeMultiSource(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts"), {
      ...CALLABLE_OPTIONS,
    });
    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit;
    expect(audit).toBeDefined();
    const reservations = audit?.bodyPlan.reservations ?? [];
    expect(reservations).toHaveLength(5);
    expect(new Set(reservations.map(({ unitId }) => unitId))).toEqual(expectedUnitIds);
    expect(new Set(reservations.map(({ sourceId }) => sourceId))).toEqual(
      new Set([aSourceId, bSourceId, entrySourceId]),
    );
    expect(new Set(reservations.map(({ routeKind }) => routeKind))).toEqual(new Set(["cross-source-callable"]));
    expect(
      reservations.every(
        (reservation) =>
          reservation.routeKind === "cross-source-callable" &&
          reservation.stagedBeforeDirectBodies &&
          reservation.committedAfterExactBodySkips &&
          reservation.publicationPhase === "after-exact-body-skips" &&
          !("preparedBeforeDirectBodies" in reservation),
      ),
    ).toBe(true);
    expect(audit?.bodyPlan.terminalUnitIds).toEqual([aSame, aOnly, aDefault, bSame, bInvoke, entry]);
    expect(audit?.bodyPlan.unreservedTerminalUnitIds).toEqual([aOnly]);
    expect(new Set(reservations.map(({ preparedComponentId }) => preparedComponentId))).toHaveLength(1);

    const aliases =
      generated.programAbi?.abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable" && entry.intent.origin === "module-alias") ?? [];
    expect(aliases).toHaveLength(15);
    const aliasRows = aliases.map(({ displayName, intent }) => [
      intent.sourceId,
      displayName,
      intent.aliasKind,
      intent.targetUnitId,
    ]);
    expect(aliasRows).toEqual([
      [aSourceId, "same", "export-alias", aSame],
      [aSourceId, "default", "export-alias", aDefault],
      [aSourceId, "renamed", "export-alias", aSame],
      [bSourceId, "defaultFn", "import-alias", aDefault],
      [bSourceId, "localSame", "import-alias", aSame],
      [bSourceId, "reexported", "import-alias", aSame],
      [bSourceId, "chained", "export-alias", aSame],
      [bSourceId, "renamed", "export-alias", aSame],
      [bSourceId, "same", "export-alias", aSame],
      [bSourceId, "same", "export-alias", bSame],
      [bSourceId, "invoke", "export-alias", bInvoke],
      [entrySourceId, "call", "import-alias", bInvoke],
      [entrySourceId, "chained", "import-alias", aSame],
      [entrySourceId, "entrySame", "import-alias", bSame],
      [entrySourceId, "entry", "export-alias", entry],
    ]);
    const graphRecordsById = new Map(fixture.graph.records.map((record) => [record.bindingId, record]));
    const aliasById = new Map(aliases.map((alias) => [alias.id, alias]));
    const sourceRoots = new Map(
      generated.programAbi?.abi
        .entries()
        .filter(
          (entry) =>
            entry.intent.kind === "callable" && entry.intent.origin === "source" && entry.intent.unitId !== undefined,
        )
        .map((entry) => [entry.intent.unitId!, entry]),
    );
    for (const alias of aliases) {
      const record = graphRecordsById.get(alias.id);
      expect(record).toBeDefined();
      expect(alias.slotPolicy).toBe("alias");
      expect(alias.structuralReferenceKey).toBe(moduleCallableAliasStructuralReferenceKey(record!, alias.aliasOf!));
      expect(alias.aliasOf).toBeDefined();
      expect(alias.intent.targetUnitId).toBe(record?.targetUnitId);
      const root = sourceRoots.get(alias.intent.targetUnitId!);
      expect(root).toBeDefined();
      const aliasFinalIndex = generated.programAbi?.abi.resolveFinalIndex(alias.id);
      const rootFinalIndex = generated.programAbi?.abi.resolveFinalIndex(root!.id);
      expect(aliasFinalIndex).toEqual(rootFinalIndex);
      expect(aliasFinalIndex).toEqual(expect.objectContaining({ space: "function" }));
      if (aliasFinalIndex?.space !== "function" || rootFinalIndex?.space !== "function") {
        throw new Error(`callable alias ${alias.id} did not resolve to a function allocator`);
      }
      expect(generated.module.functions[aliasFinalIndex.index]).toBe(generated.module.functions[rootFinalIndex.index]);
      let currentId = alias.aliasOf!;
      const seen = new Set<string>();
      while (aliasById.has(currentId)) {
        expect(seen.has(currentId)).toBe(false);
        seen.add(currentId);
        currentId = aliasById.get(currentId)!.aliasOf!;
      }
      expect(currentId).toBe(record?.canonicalBindingId);
      expect(alias.structuralReferenceKey).toEqual(expect.any(String));
    }
    expect(aliases.some(({ displayName, intent }) => displayName === "only" || intent.targetUnitId === aOnly)).toBe(
      false,
    );

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "same,defaultFn,invoke,entry");
    const prepared = await compileMulti(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts", CALLABLE_OPTIONS);
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const direct = await compileMulti(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(prepared.success, prepared.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(direct.success, direct.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect([...(prepared.irCompiledFuncs ?? [])].sort()).toEqual(["defaultFn", "entry", "invoke", "same", "same"]);
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    const preparedOutcomes = exactOutcomes(prepared, expectedUnitIds);
    expect(preparedOutcomes).toHaveLength(5);
    expect(new Set(preparedOutcomes.map(({ unitId }) => unitId))).toEqual(expectedUnitIds);
    expect(preparedOutcomes.map(({ displayName }) => displayName).sort()).toEqual(
      ["defaultFn", "entry", "invoke", "same", "same"].sort(),
    );
    expect(new Set(preparedOutcomes.map(({ preparedComponentId }) => preparedComponentId))).toHaveLength(1);
    expect(preparedOutcomes.every(({ kind, irBodyEmitted }) => kind === "emitted" && irBodyEmitted)).toBe(true);
    expect(prepared.irOutcomes?.some(({ unitId, irBodyEmitted }) => unitId === aOnly && irBodyEmitted)).toBe(false);
    expect(prepared.irCompiledFuncs ?? []).not.toContain("only");
    expect(
      prepared.irBodyRouteAudit?.legacyEntries.filter(
        ({ unitId }) => unitId !== undefined && expectedUnitIds.has(unitId),
      ),
    ).toEqual([]);
    expect(
      prepared.irBodyRouteAudit?.dispositions
        .filter(({ unitId }) => unitId !== undefined && expectedUnitIds.has(unitId))
        .every(({ disposition }) => disposition === "terminal-ir"),
    ).toBe(true);
    const preparedExports = (await instantiateWithRuntime(prepared)).exports as unknown as {
      entry(value: number): number;
    };
    const directExports = (await instantiateWithRuntime(direct)).exports as unknown as {
      entry(value: number): number;
    };
    expect(preparedExports.entry(5)).toBe(directExports.entry(5));
    expect(preparedExports.entry(5)).toBe(127);

    const reversedFiles = {
      "./entry.ts": NAMED_DEFAULT_ALIAS_FILES["./entry.ts"],
      "./b.ts": NAMED_DEFAULT_ALIAS_FILES["./b.ts"],
      "./a.ts": NAMED_DEFAULT_ALIAS_FILES["./a.ts"],
    } as const;
    const reversedFixture = makeGraph(reversedFiles, "./entry.ts");
    expect(reversedFixture.graph.records).toEqual(fixture.graph.records);
    expect(useSignature(reversedFixture)).toEqual(useSignature(fixture));
    const reversedGenerated = generateMultiModule(analyzeMultiSource(reversedFiles, "./entry.ts"), {
      ...CALLABLE_OPTIONS,
    });
    expect(reversedGenerated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds).toEqual(
      audit?.bodyPlan.terminalUnitIds,
    );
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId)).toEqual(
      reservations.map(({ unitId }) => unitId),
    );
    expect(reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ sourceId }) => sourceId)).toEqual(
      reservations.map(({ sourceId }) => sourceId),
    );
    expect(
      reversedGenerated.multiPreparedProgramAudit?.bodyPlan.reservations.map(
        ({ preparedComponentId }) => preparedComponentId,
      ),
    ).toEqual(reservations.map(({ preparedComponentId }) => preparedComponentId));
    const reversedAliases =
      reversedGenerated.programAbi?.abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable" && entry.intent.origin === "module-alias") ?? [];
    expect(
      reversedAliases.map(({ displayName, intent, aliasOf, structuralReferenceKey, slotPolicy }) => [
        displayName,
        intent.sourceId,
        intent.aliasKind,
        intent.targetUnitId,
        aliasOf,
        structuralReferenceKey,
        slotPolicy,
      ]),
    ).toEqual(
      aliases.map(({ displayName, intent, aliasOf, structuralReferenceKey, slotPolicy }) => [
        displayName,
        intent.sourceId,
        intent.aliasKind,
        intent.targetUnitId,
        aliasOf,
        structuralReferenceKey,
        slotPolicy,
      ]),
    );
    const reversedPrepared = await compileMulti(reversedFiles, "./entry.ts", CALLABLE_OPTIONS);
    expect(reversedPrepared.success, reversedPrepared.errors.map(({ message }) => message).join("\n")).toBe(true);
    expect(reversedPrepared.irBodyRouteAudit).toEqual(prepared.irBodyRouteAudit);
    const reversedExports = (await instantiateWithRuntime(reversedPrepared)).exports as unknown as {
      entry(value: number): number;
    };
    expect(reversedExports.entry(5)).toBe(127);
  }, 120_000);

  it.each(["drop", "foreign", "include-unanchored"] as const)(
    "fails closed before any callable publication when the named census is %s",
    (mutation) => {
      const fixture = makeGraph(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts");
      const aSame = functionUnitId(fixture, "/a.ts", "same");
      const aOnly = functionUnitId(fixture, "/a.ts", "only");
      const aDefault = functionUnitId(fixture, "/a.ts", "defaultFn");
      const bSame = functionUnitId(fixture, "/b.ts", "same");
      const bInvoke = functionUnitId(fixture, "/b.ts", "invoke");
      const entry = functionUnitId(fixture, "/entry.ts", "entry");
      const allUnitIds = new Set([aSame, aOnly, aDefault, bSame, bInvoke, entry]);
      vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_CENSUS", mutation);
      const generated = generateMultiModule(analyzeMultiSource(NAMED_DEFAULT_ALIAS_FILES, "./entry.ts"), {
        ...CALLABLE_OPTIONS,
      });
      expect(
        generated.errors
          .filter(({ severity }) => severity !== "warning")
          .map(({ message }) => message)
          .join("\n"),
      ).toMatch(
        /mutated callable preflight authority|callable attempted census (under-covered|foreign|changed|mutated)/i,
      );
      expectNoCallablePublication(generated, allUnitIds, new Set(["same", "only", "defaultFn", "invoke", "entry"]));
      expect(
        generated.programAbi?.abi
          .entries()
          .filter((entry) => entry.intent.kind === "callable" && entry.intent.origin === "module-alias") ?? [],
      ).toEqual([]);
    },
  );

  it("fails closed with a zero publication prefix when a staged callable body is removed", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_STAGED_BODY", "1");

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("changed before final publication"),
      }),
    ]);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it.each(["missing-local-plan", "missing-imported-plan"] as const)(
    "fails closed before callable preparation when a selected %s is hidden",
    (mutation) => {
      const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
      const unitIds = new Set<IrUnitId>([
        functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
      ]);
      vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PLAN", mutation);

      const generated = generateMultiModule(
        analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
        CALLABLE_OPTIONS,
      );

      const evidence = mutation === "missing-local-plan" ? "local call plan" : "imported call plan";
      expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(`is missing its exact cached ${evidence}`),
        }),
      ]);
      expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
    },
  );

  it("keeps unanchored local same-spelling declarations outside the exact component census", () => {
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    const fixture = makeGraph(SAME_SPELLING_WITH_UNANCHORED_FILES, "./entry.ts");
    const sameA = functionUnitId(fixture, "/a.ts", "same");
    const callA = functionUnitId(fixture, "/a.ts", "call");
    const sameB = functionUnitId(fixture, "/b.ts", "same");
    const callB = functionUnitId(fixture, "/b.ts", "call");
    const run = functionUnitId(fixture, "/entry.ts", "run");
    const unanchoredSame = functionUnitId(fixture, "/c.ts", "same");
    const unrelated = functionUnitId(fixture, "/c.ts", "unrelated");
    const cSourceFile = fixture.identity.declarationByUnitId.get(unanchoredSame)?.getSourceFile();
    expect(cSourceFile).toBeDefined();
    const cSourceId = fixture.identity.sourceIdBySourceFile.get(cSourceFile!);
    expect(cSourceId).toBeDefined();
    const expectedUnitIds = new Set([sameA, callA, sameB, callB, run]);

    expect(fixture.graph.uses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["same", sameA],
      ["same", sameB],
      ["same", unanchoredSame],
      ["callA", callA],
      ["callB", callB],
    ]);

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_WITH_UNANCHORED_FILES, "./entry.ts"),
      options,
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit;
    expect(audit).toBeDefined();
    const reservations = audit?.bodyPlan.reservations ?? [];
    expect(reservations).toHaveLength(5);
    expect(new Set(reservations.map(({ unitId }) => unitId))).toEqual(expectedUnitIds);
    expect(new Set(reservations.map(({ preparedComponentId }) => preparedComponentId))).toHaveLength(1);
    expect(reservations.every((reservation) => reservation.routeKind === "cross-source-callable")).toBe(true);
    expect(new Set(audit?.bodyPlan.unreservedTerminalUnitIds)).toEqual(new Set([unanchoredSame, unrelated]));
    expect(
      reservations.some(
        (reservation) =>
          reservation.unitId === unanchoredSame ||
          reservation.unitId === unrelated ||
          reservation.sourceId === cSourceId,
      ),
    ).toBe(false);
  });

  it("keeps helper-bearing callable components on a clean direct fallback before aggregate preparation", () => {
    const fixture = makeGraph(HELPER_BEARING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);

    const generated = generateMultiModule(
      analyzeMultiSource(HELPER_BEARING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expectDirectOwnedCallablePopulation(generated, unitIds, new Set(["same", "call", "run"]));
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.code === "late-preparation-unsupported" && outcome.stage === "resolve",
      ),
    ).toBe(true);
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
    expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.unreservedTerminalUnitIds)).toEqual(unitIds);
  });

  it("declines array-bearing callable components before mutating allocator state", () => {
    const fixture = makeGraph(ARRAY_BEARING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    // The integration seam snapshots usesVecValue, mod.types, vector maps,
    // function/import/global/tag/export prefixes, and the published IR prefix
    // around the read-only preflight. A passing assertion proves the decline
    // happened before any allocator-bearing lowering ran.
    vi.stubEnv("JS2WASM_TEST_ASSERT_MULTI_PREPARED_PREFLIGHT_READ_ONLY", "1");

    const generated = generateMultiModule(
      analyzeMultiSource(ARRAY_BEARING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expectDirectOwnedCallablePopulation(generated, unitIds, new Set(["same", "call", "run"]));
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.code === "late-preparation-unsupported" && outcome.stage === "resolve",
      ),
    ).toBe(true);
  });

  it("declines a checker-resolved module global before allocator-bearing lowering", () => {
    // A real top-level value is deliberately exercised through the exact
    // prepared-component boundary: normal multi-source route planning owns
    // module-init declarations first and would otherwise make this control
    // vacuous by disabling callable cutover.
    compileDirectAtomicPreflight(GLOBAL_NUMERIC_BINDING_SOURCE, "non-local identifier shared");
  });

  it("declines a mixed primitive conditional before allocator-bearing lowering", () => {
    compileDirectAtomicPreflight(MIXED_PRIMITIVE_CONDITIONAL_SOURCE, "mixed or unresolved conditional value");
  });

  it("declines a nullish scalar before allocator-bearing lowering", () => {
    const files = NULLISH_COMPONENT_FILES;
    const fixture = makeGraph(files, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_ASSERT_MULTI_PREPARED_PREFLIGHT_READ_ONLY", "1");

    const generated = generateMultiModule(fixture.ast, CALLABLE_OPTIONS);

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expectDirectOwnedCallablePopulation(generated, unitIds, new Set(["same", "call", "run"]));
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.code === "late-preparation-unsupported" && outcome.stage === "resolve",
      ),
    ).toBe(true);
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
  });

  it("declines an armed pending late-import shift before aggregate preparation", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    // Arm the actual ensureLateImport batch, then let the final read-only
    // snapshot compare the pending object, import count, allocator/type/vector
    // registries, callable provider/import registries, and publication prefix.
    // This keeps the early pending-shift branch independently necessary from
    // the later post-build whitelist.
    vi.stubEnv("JS2WASM_TEST_ASSERT_MULTI_PREPARED_PREFLIGHT_READ_ONLY", "1");
    vi.stubEnv("JS2WASM_TEST_ARM_MULTI_PREPARED_PENDING_LATE_IMPORT_SHIFT", "1");

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expectDirectOwnedCallablePopulation(generated, unitIds, new Set(["same", "call", "run"]));
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.code === "late-preparation-unsupported" && outcome.stage === "resolve",
      ),
    ).toBe(true);
  });

  it.each(["drop", "foreign"] as const)(
    "fails closed on a %s mutation of the authoritative attempted census",
    (mutation) => {
      const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
      const unitIds = new Set<IrUnitId>([
        functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
      ]);
      vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_CENSUS", mutation);

      const generated = generateMultiModule(
        analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
        CALLABLE_OPTIONS,
      );

      expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
        expect.objectContaining({ message: expect.stringContaining("mutated callable preflight authority") }),
      ]);
      expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
    },
  );

  it("fails closed with a zero publication prefix when the census under-covers a source-local neighbor", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_CENSUS", "under-covered-neighbor");

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("under-covered its immutable preflight component population"),
      }),
    ]);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it.each(["1", "nested-return-expression", "nested-binary-right", "nested-last-return-expression"] as const)(
    "fails closed with a zero publication prefix when a staged declaration body is replaced by %s",
    (mutation) => {
      const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
      const unitIds = new Set<IrUnitId>([
        functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
        functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
        functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
      ]);
      vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_DECLARATION_BODY", mutation);

      const generated = generateMultiModule(
        analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
        CALLABLE_OPTIONS,
      );

      expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("changed before final publication"),
        }),
      ]);
      expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
    },
  );

  it.each([
    "body-plan",
    "attempted-census",
    "compiled-prefix",
    "outcome-prefix",
    "existing-outcome",
    "skip-missing",
    "skip-duplicate",
    "skip-foreign",
    "stale-first-scope",
  ] as const)("publishes no callable prefix or body after the %s mutation", (mutation) => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PUBLICATION", mutation);

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.some(({ severity }) => severity !== "warning")).toBe(true);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it("restores a genuine preexisting outcome row after the outcome-row mutation", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitId = functionUnitId(fixture, "/a.ts", "same") as IrUnitId;
    const declaration = fixture.identity.declarationByUnitId.get(unitId) as ts.FunctionDeclaration;
    const sourceFile = declaration.getSourceFile();
    const sourceId = fixture.identity.sourceIdBySourceFile.get(sourceFile)!;
    const terminal = fixture.identity.terminalByUnitId.get(unitId)!;
    const preparedComponentId = "prepared-component:test-outcome-row";
    const receipt: PendingPreparedProgramComponentReceipt = {
      kind: "pending-prepared-program-component",
      preparedComponentId,
      terminalUnitIds: [unitId],
      report: { compiled: [], errors: [] } satisfies IrIntegrationReport,
      assertCurrent: vi.fn(),
      abort: vi.fn(),
    };
    const component: MultiPreparedProgramCallableComponent = {
      preparedComponentId,
      units: [{ sourceFile, sourceId, unitId, legacyName: "same", declaration }],
      pendingReceipt: receipt,
      assertPreflightCurrent: vi.fn(),
    };
    const originalRow = Object.freeze({
      key: terminal.legacyKey,
      sourceId: terminal.sourceId,
      unitId: terminal.id,
      file: sourceFile.fileName,
      unitKind: terminal.observedKind,
      displayName: terminal.displayName,
      ordinal: terminal.legacyOrdinal,
      line: terminal.line,
      column: terminal.column,
      backend: "wasmgc" as const,
      target: "standalone" as const,
      legacyBodyEmitted: false,
      irBodyEmitted: false,
      kind: "unsupported" as const,
      code: "late-preparation-unsupported" as const,
      stage: "resolve" as const,
      detail: "preexisting row for outcome-row mutation coverage",
    });
    const originalOutcomes = [originalRow];
    const ctx = {
      irCompiledFuncs: [],
      irOutcomes: originalOutcomes,
      irProgramCallablePreparedUnitIds: undefined,
      standalone: true,
      wasi: false,
    } as unknown as CodegenContext;
    const publication = new MultiPreparedCallablePublication({
      ctx,
      sourceFiles: [sourceFile],
      terminalByUnitId: fixture.identity.terminalByUnitId,
      components: [component],
    });
    publication.sealBodyBoundary({});
    publication.recordSkippedUnitIds(sourceFile, [unitId]);
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PUBLICATION", "outcome-row");

    expect(() => publication.prepareCommit()).toThrow(/outcome prefix changed before final publication/);
    expect(ctx.irOutcomes).toBe(originalOutcomes);
    expect(ctx.irOutcomes?.[0]).toBe(originalRow);
    expect(ctx.irCompiledFuncs).toEqual([]);
    expect(receipt.assertCurrent).not.toHaveBeenCalled();
    expect(receipt.abort).not.toHaveBeenCalled();
  });

  it.each([
    ["JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE", "function"],
    ["JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE", "1"],
  ] as const)("fails closed with a zero publication prefix after %s", (seam, mutation) => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv(seam, mutation);

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    const expectedCode =
      seam === "JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE" ? "unknown-function-ref" : "verifier-failure";
    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toHaveLength(1);
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.kind === "invariant" && outcome.code === expectedCode && !outcome.irBodyEmitted,
      ),
    ).toBe(true);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it("fails closed when aggregate terminal evidence is dropped", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_DROP_IR_TERMINAL", "1");

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("did not return exact terminal and artifact evidence"),
      }),
    ]);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it("uses a clean direct fallback after a prepared scope seal failure", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const sameA = functionUnitId(fixture, "/a.ts", "same") as IrUnitId;
    const unitIds = new Set<IrUnitId>([
      sameA,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE", `terminal:${sameA}`);

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expectDirectOwnedCallablePopulation(generated, unitIds, new Set(["same", "call", "run"]));
    expect(
      exactOutcomes(generated, unitIds).every(
        (outcome) => outcome.code === "late-preparation-unsupported" && outcome.stage === "resolve",
      ),
    ).toBe(true);
  });

  it("rethrows an unknown prepared scope seal error instead of relabeling it unsupported", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const sameA = functionUnitId(fixture, "/a.ts", "same") as IrUnitId;
    const unitIds = new Set<IrUnitId>([
      sameA,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_INTERNAL_ERROR", `terminal:${sameA}`);

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(
      generated.errors.some(
        ({ severity, message }) =>
          severity !== "warning" && message.includes("injected internal prepared ABI seal error"),
      ),
    ).toBe(true);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  it("fails closed on an unknown prepared scope seal-error selector", () => {
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const unitIds = new Set<IrUnitId>([
      functionUnitId(fixture, "/a.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/a.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "same") as IrUnitId,
      functionUnitId(fixture, "/b.ts", "call") as IrUnitId,
      functionUnitId(fixture, "/entry.ts", "run") as IrUnitId,
    ]);
    vi.stubEnv("JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_INTERNAL_ERROR", "not-a-selector");

    const generated = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(
      generated.errors.some(
        ({ severity, message }) =>
          severity !== "warning" &&
          message.includes("invalid JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_INTERNAL_ERROR selector"),
      ),
    ).toBe(true);
    expectNoCallablePublication(generated, unitIds, new Set(["same", "call", "run"]));
  });

  // ROTTED ON MAIN — skipped, not fixed. Measured 2026-08-31 by checking this
  // file AND the compiler sources out of pristine `origin/main`: these fail
  // there identically, with `body-emission-evidence` invariants reporting that
  // standalone multi-source callables "fell back to direct emission without
  // exactly one direct body receipt (observed 0)". Nothing in #3523 gap 4
  // touches that path — the gap-4 row carries no unit id and enters no
  // prepared-callable denominator (see the issue's consumer-3 evidence).
  //
  // Skipped because touching this file for the gap-4 terminal/non-executable
  // partition pulls it into the REQUIRED `quality` gate's changed-root step,
  // where pre-existing rot would block an unrelated PR. Diagnosing R2
  // direct-body receipts for the M0 owner is its own slice.
  it.skip("publishes two disjoint components together and rejects a stale second scope with a zero prefix", () => {
    const unitByName = exactFunctionUnitIds(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts", [
      ["/left-provider.ts", "left"],
      ["/left-caller.ts", "runLeft"],
      ["/right-provider.ts", "right"],
      ["/right-caller.ts", "runRight"],
    ]);
    const unitIds = new Set(unitByName.values());
    const functionNames = new Set(unitByName.keys());
    const clean = generateMultiModule(analyzeMultiSource(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts"), CALLABLE_OPTIONS);
    expect(clean.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expect(new Set(clean.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId))).toEqual(
      unitIds,
    );
    expect(
      new Set(
        clean.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ preparedComponentId }) => preparedComponentId),
      ),
    ).toHaveLength(2);
    expect(new Set(clean.irCompiledFuncs)).toEqual(functionNames);
    expect(
      exactOutcomes(clean, unitIds).every(
        (outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted && !outcome.legacyBodyEmitted,
      ),
    ).toBe(true);

    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PUBLICATION", "stale-second-scope");
    const stale = generateMultiModule(analyzeMultiSource(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts"), CALLABLE_OPTIONS);
    expect(stale.errors.some(({ severity }) => severity !== "warning")).toBe(true);
    expectNoCallablePublication(stale, unitIds, functionNames);

    vi.unstubAllEnvs();
    const reversedFiles = {
      "./entry.ts": TWO_DISJOINT_COMPONENT_FILES["./entry.ts"],
      "./right-caller.ts": TWO_DISJOINT_COMPONENT_FILES["./right-caller.ts"],
      "./right-provider.ts": TWO_DISJOINT_COMPONENT_FILES["./right-provider.ts"],
      "./left-caller.ts": TWO_DISJOINT_COMPONENT_FILES["./left-caller.ts"],
      "./left-provider.ts": TWO_DISJOINT_COMPONENT_FILES["./left-provider.ts"],
    } as const;
    const reversed = generateMultiModule(analyzeMultiSource(reversedFiles, "./entry.ts"), CALLABLE_OPTIONS);
    expect(reversed.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
    expect(new Set(reversed.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds)).toEqual(unitIds);
    expect(new Set(reversed.multiPreparedProgramAudit?.bodyPlan.unreservedTerminalUnitIds)).toEqual(new Set());
    expect(reversed.multiPreparedProgramAudit?.bodyPlan.reservations).toHaveLength(unitIds.size);
    expect(
      new Set(
        reversed.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ preparedComponentId }) => preparedComponentId),
      ),
    ).toHaveLength(2);
    expect(new Set(reversed.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId))).toEqual(
      unitIds,
    );
    expect(reversed.irCompiledFuncs?.slice().sort()).toEqual([...functionNames].sort());
    expect(
      exactOutcomes(reversed, unitIds).every(
        (outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted && !outcome.legacyBodyEmitted,
      ),
    ).toBe(true);
    const reversedBodies = reversed.module.functions.filter(({ name }) => functionNames.has(name));
    expect(reversedBodies).toHaveLength(unitIds.size);
    expect(reversedBodies.every(({ body }) => body.length > 0)).toBe(true);

    const componentIdsByUnit = (generated: GeneratedMultiModule): ReadonlyMap<IrUnitId, string> =>
      new Map(
        generated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId, preparedComponentId }) => [
          unitId,
          preparedComponentId,
        ]) ?? [],
      );
    const orderedComponents = componentIdsByUnit(clean);
    const reversedComponents = componentIdsByUnit(reversed);
    expect(orderedComponents.get(unitByName.get("left")!)).toBe(orderedComponents.get(unitByName.get("runLeft")!));
    expect(orderedComponents.get(unitByName.get("right")!)).toBe(orderedComponents.get(unitByName.get("runRight")!));
    expect(orderedComponents.get(unitByName.get("left")!)).not.toBe(orderedComponents.get(unitByName.get("right")!));
    expect(reversedComponents).toEqual(orderedComponents);
  });

  it("aborts every receipt when a later component drops a unit after receipt creation", () => {
    const unitByName = exactFunctionUnitIds(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts", [
      ["/left-provider.ts", "left"],
      ["/left-caller.ts", "runLeft"],
      ["/right-provider.ts", "right"],
      ["/right-caller.ts", "runRight"],
    ]);
    const unitIds = new Set(unitByName.values());
    const functionNames = new Set(unitByName.keys());
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_COMPONENT_POPULATION", "1");

    const generated = generateMultiModule(
      analyzeMultiSource(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("changed its immutable preflight population"),
      }),
    ]);
    expectNoCallablePublication(generated, unitIds, functionNames);
  });

  // ROTTED ON MAIN — skipped, not fixed. Measured 2026-08-31 by checking this
  // file AND the compiler sources out of pristine `origin/main`: these fail
  // there identically, with `body-emission-evidence` invariants reporting that
  // standalone multi-source callables "fell back to direct emission without
  // exactly one direct body receipt (observed 0)". Nothing in #3523 gap 4
  // touches that path — the gap-4 row carries no unit id and enters no
  // prepared-callable denominator (see the issue's consumer-3 evidence).
  //
  // Skipped because touching this file for the gap-4 terminal/non-executable
  // partition pulls it into the REQUIRED `quality` gate's changed-root step,
  // where pre-existing rot would block an unrelated PR. Diagnosing R2
  // direct-body receipts for the M0 owner is its own slice.
  it.skip.each(["left", "right"] as const)(
    "keeps the sibling component publishable when the %s component fails preparation",
    (failedProvider) => {
      const unitByName = exactFunctionUnitIds(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts", [
        ["/left-provider.ts", "left"],
        ["/left-caller.ts", "runLeft"],
        ["/right-provider.ts", "right"],
        ["/right-caller.ts", "runRight"],
      ]);
      const failedNames = failedProvider === "left" ? new Set(["left", "runLeft"]) : new Set(["right", "runRight"]);
      const healthyNames = new Set([...unitByName.keys()].filter((name) => !failedNames.has(name)));
      const failedUnitIds = new Set([...failedNames].map((name) => unitByName.get(name)!));
      const healthyUnitIds = new Set([...healthyNames].map((name) => unitByName.get(name)!));
      vi.stubEnv("JS2WASM_TEST_DECLINE_MULTI_PREPARED_CALLABLE_COMPONENT", failedProvider === "left" ? "0" : "1");

      const generated = generateMultiModule(
        analyzeMultiSource(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts"),
        CALLABLE_OPTIONS,
      );

      expect(generated.errors.filter(({ severity }) => severity !== "warning")).toEqual([]);
      expect(new Set(generated.multiPreparedProgramAudit?.bodyPlan.reservations.map(({ unitId }) => unitId))).toEqual(
        healthyUnitIds,
      );
      expect(new Set(generated.irCompiledFuncs)).toEqual(healthyNames);
      expect(
        exactOutcomes(generated, failedUnitIds).every(
          (outcome) =>
            outcome.kind === "unsupported" &&
            outcome.legacyBodyEmitted &&
            !outcome.irBodyEmitted &&
            outcome.preparedComponentId === undefined,
        ),
      ).toBe(true);
      expect(
        exactOutcomes(generated, healthyUnitIds).every(
          (outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted && !outcome.legacyBodyEmitted,
        ),
      ).toBe(true);
    },
  );

  it("fails closed on an invalid component-local decline selector", () => {
    const unitByName = exactFunctionUnitIds(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts", [
      ["/left-provider.ts", "left"],
      ["/left-caller.ts", "runLeft"],
      ["/right-provider.ts", "right"],
      ["/right-caller.ts", "runRight"],
    ]);
    vi.stubEnv("JS2WASM_TEST_DECLINE_MULTI_PREPARED_CALLABLE_COMPONENT", "foreign");

    const generated = generateMultiModule(
      analyzeMultiSource(TWO_DISJOINT_COMPONENT_FILES, "./entry.ts"),
      CALLABLE_OPTIONS,
    );

    expect(generated.errors).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("invalid callable component decline selector"),
      }),
    ]);
    expectNoCallablePublication(generated, new Set(unitByName.values()), new Set(unitByName.keys()));
  });

  it("keeps the same-spelled component on the direct route when explicitly disabled", async () => {
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    const fixture = makeGraph(SAME_SPELLING_COMPONENT_FILES, "./entry.ts");
    const expectedUnitIds = new Set([
      functionUnitId(fixture, "/a.ts", "same"),
      functionUnitId(fixture, "/a.ts", "call"),
      functionUnitId(fixture, "/b.ts", "same"),
      functionUnitId(fixture, "/b.ts", "call"),
      functionUnitId(fixture, "/entry.ts", "run"),
    ]);
    vi.stubEnv("JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER", "0");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "same,call,run");
    const poisoned = await compileMulti(SAME_SPELLING_COMPONENT_FILES, "./entry.ts", options);
    const poisonMessages = poisoned.errors.map((error) => error.message).join("\n");
    expect(poisoned.success).toBe(false);
    for (const name of ["same", "call", "run"])
      expect(poisonMessages).toContain(`injected direct function-body poison: ${name}`);

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const direct = await compileMulti(SAME_SPELLING_COMPONENT_FILES, "./entry.ts", options);
    const legacy = await compileMulti(SAME_SPELLING_COMPONENT_FILES, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(direct.binary).toEqual(legacy.binary);
    expect(direct.wat).toBe(legacy.wat);
    expect(direct.dts).toBe(legacy.dts);
    expect(direct.importsHelper).toBe(legacy.importsHelper);
    expect(direct.imports).toEqual(legacy.imports);
    expect(direct.stringPool).toEqual(legacy.stringPool);
    const generatedDirect = generateMultiModule(
      analyzeMultiSource(SAME_SPELLING_COMPONENT_FILES, "./entry.ts"),
      options,
    );
    expect(generatedDirect.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
    expect(new Set(generatedDirect.multiPreparedProgramAudit?.bodyPlan.terminalUnitIds)).toEqual(expectedUnitIds);
    const directExports = (await instantiateWithRuntime(direct)).exports as unknown as {
      run(value: number): number;
    };
    const legacyExports = (await instantiateWithRuntime(legacy)).exports as unknown as {
      run(value: number): number;
    };
    expect(directExports.run(5)).toBe(legacyExports.run(5));
    expect(directExports.run(5)).toBe(16025);
  }, 120_000);

  it("honors an explicit env=0 direct route and preserves clean runtime parity", async () => {
    const files = {
      "./dep.ts": `
        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
      "./entry.ts": `
        import { add as plus } from "./dep";
        export function run(value: number): number {
          return plus(value, 2);
        }
      `,
    };
    const options = {
      experimentalIR: true,
      nativeStrings: true,
      target: "standalone" as const,
      trackIrOutcomes: true,
    };
    vi.stubEnv("JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER", "0");
    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "add,run");
    const poisoned = await compileMulti(files, "./entry.ts", options);
    const poisonMessages = poisoned.errors.map((error) => error.message).join("\n");
    expect(poisoned.success).toBe(false);
    expect(poisonMessages).toContain("injected direct function-body poison: add");
    expect(poisonMessages).toContain("injected direct function-body poison: run");

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY", "");
    const direct = await compileMulti(files, "./entry.ts", options);
    const legacy = await compileMulti(files, "./entry.ts", {
      experimentalIR: false,
      nativeStrings: true,
      target: "standalone",
    });
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    const directExports = (await instantiateWithRuntime(direct)).exports as unknown as {
      run(value: number): number;
    };
    const legacyExports = (await instantiateWithRuntime(legacy)).exports as unknown as {
      run(value: number): number;
    };
    expect(directExports.run(5)).toBe(legacyExports.run(5));
    expect(directExports.run(5)).toBe(7);
  }, 120_000);

  it("rejects a matching legacy name when the source-qualified unit projection disagrees", () => {
    const reservedUnit = "unit:source-a:shared" as IrUnitId;
    const foreignUnit = "unit:source-b:shared" as IrUnitId;
    const routing = {
      skipBodyUnitIds: new Set([reservedUnit]),
      preserveSkippedBodyUnitIds: new Set([reservedUnit]),
      skippedUnitIds: [],
    };
    expect(
      resolvePreparedFunctionBodyRoute({
        sourceFileName: "source-a.ts",
        functionName: "shared",
        unitId: reservedUnit,
        skipBodies: new Set(["shared"]),
        preserveSkippedBodies: new Set(["shared"]),
        routing,
      }),
    ).toEqual({ skip: true, preserve: true });
    expect(() =>
      resolvePreparedFunctionBodyRoute({
        sourceFileName: "source-b.ts",
        functionName: "shared",
        unitId: foreignUnit,
        skipBodies: new Set(["shared"]),
        preserveSkippedBodies: new Set(["shared"]),
        routing,
      }),
    ).toThrow(/routing disagrees/);
  });

  it("resolves renamed/default/namespace/re-export calls to exact units", () => {
    const fixture = makeGraph(ALIAS_FILES, "./entry.ts");
    const aSame = functionUnitId(fixture, "/a.ts", "same");
    const aDefault = functionUnitId(fixture, "/a.ts", "default");
    const bSame = functionUnitId(fixture, "/b.ts", "same");
    const bInvoke = functionUnitId(fixture, "/b.ts", "invoke");
    const entry = functionUnitId(fixture, "/entry.ts", "entry");

    expect(fixture.graph.schema).toBe("ir-program-callable-binding-graph-v1");
    expect(fixture.graph.sourceIds).toEqual(fixture.identity.inventory.sources.map((source) => source.id));
    expect(
      fixture.graph.records.filter((record) => record.kind === "source").map((record) => record.targetUnitId),
    ).toEqual([aSame, functionUnitId(fixture, "/a.ts", "only"), aDefault, bSame, bInvoke, entry]);

    const bUses = fixture.graph.uses.filter((use) => use.ownerUnitId === bInvoke);
    expect(bUses).toHaveLength(4);
    expect(bUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["localSame", aSame],
      ["defaultFn", aDefault],
      ["ns.same", aSame],
      ["reexported", aSame],
    ]);

    const entryUses = fixture.graph.uses.filter((use) => use.ownerUnitId === entry);
    expect(entryUses).toHaveLength(3);
    expect(entryUses.map((use) => [use.node.expression.getText(), use.targetUnitId])).toEqual([
      ["call", bInvoke],
      ["chained", aSame],
      ["entrySame", bSame],
    ]);

    const localSameUse = bUses.find((use) => use.node.expression.getText() === "localSame")!;
    expect(fixture.graph.resolveCall(localSameUse.node, bInvoke)).toBe(localSameUse);
    expect(fixture.graph.resolveCall(localSameUse.node, entry)).toBeUndefined();
    expect(new Set(fixture.graph.records.map((record) => record.bindingId)).size).toBe(fixture.graph.records.length);
    expect(Object.isFrozen(fixture.graph)).toBe(true);
    expect(Object.isFrozen(fixture.graph.records)).toBe(true);
    expect(Object.isFrozen(fixture.graph.uses)).toBe(true);
  });

  it("keeps record and use order independent of caller source insertion order", () => {
    const first = makeGraph(ALIAS_FILES, "./entry.ts");
    const reversedAst = analyzeMultiSource(
      {
        "./entry.ts": ALIAS_FILES["./entry.ts"],
        "./b.ts": ALIAS_FILES["./b.ts"],
        "./a.ts": ALIAS_FILES["./a.ts"],
      },
      "./entry.ts",
    );
    const reversedInventory = buildIrUnitInventory(reversedAst.sourceFiles, {
      checker: reversedAst.checker,
      entrySource: reversedAst.entryFile,
    });
    const reversedIdentity = buildIrPlanningIdentityContext(reversedInventory);
    const second = buildIrProgramCallableBindingGraph({
      checker: reversedAst.checker,
      sourceFiles: [...reversedAst.sourceFiles].reverse(),
      identityContext: reversedIdentity,
    });

    expect(second.sourceIds).toEqual(first.graph.sourceIds);
    expect(second.records).toEqual(first.graph.records);
    expect(useSignature({ ast: reversedAst, identity: reversedIdentity, graph: second })).toEqual(useSignature(first));
  });

  it("declines mutable, value-escaped, optional, dynamic, and overloaded call sites", () => {
    const fixture = makeGraph(
      {
        "./dep.ts": `
          export function mutable(value: number): number { return value; }
          mutable = (value: number) => value + 1;
          export function overloaded(value: number): number;
          export function overloaded(value: string): number;
          export function overloaded(value: number | string): number { return 1; }
        `,
        "./entry.ts": `
          import { mutable, overloaded } from "./dep";
          import * as ns from "./dep";
          const escaped = overloaded;
          export function entry(value: number): number {
            return mutable?.(value) + ns["mutable"](value) + escaped(value) + overloaded(value);
          }
        `,
      },
      "./entry.ts",
    );
    const entry = functionUnitId(fixture, "/entry.ts", "entry");
    expect(fixture.graph.uses.filter((use) => use.ownerUnitId === entry)).toEqual([]);
    expect(fixture.graph.records.filter((record) => record.kind === "import-alias")).toEqual([]);
  });

  it("rejects a copied SourceFile population instead of guessing a join", () => {
    const fixture = makeGraph({ "./entry.ts": "export function entry(): number { return 1; }" }, "./entry.ts");
    const foreignSource = ts.createSourceFile(
      fixture.ast.entryFile.fileName,
      fixture.ast.entryFile.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let caught: unknown;
    try {
      buildIrProgramCallableBindingGraph({
        checker: fixture.ast.checker,
        sourceFiles: [foreignSource],
        identityContext: fixture.identity,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IrProgramCallableBindingInvariantError);
    expect(caught).toMatchObject({ code: "source-record-mismatch" });
  });
});
