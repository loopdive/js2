// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5299 — a published prepared-callable row must CARRY its
 * `(prepareAttempts, directBodyEmissions, irBodyEmissions)` triple.
 *
 * Before this slice the rows built by `MultiPreparedCallablePublication`
 * carried none of the three fields. `hasMalformedBodyEmissionAccounting`
 * treats a wholly absent triple as well-formed, so the rows passed every
 * invariant and then dropped out of every ratio computed over the R2
 * population — the R9 denominator problem, on the population most certain to
 * be IR-emitted.
 *
 * Two things are worth knowing about the shape of this file:
 *
 * 1. The affected population is **multi-source and standalone-only**. Measured
 *    2026-09-03 across seven option lanes: `compileMulti` reaches the prepared
 *    callable route under `target: "standalone"` and under no gc or wasi
 *    spelling, and single-source `compile()` never reaches it at all (the
 *    publication only ever stages cross-source `top-level-function` terminals).
 *    That is why the end-to-end arm below is a `compileMulti` standalone case
 *    and not a corpus sweep.
 * 2. There is **no `JS2WASM_TEST_*` poison that forces a direct body receipt
 *    for a prepared unit** — the direct census is recorded by physically
 *    entering `compileFunctionBody`, which a prepared unit is skipped out of by
 *    construction, and `JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY` proves the
 *    opposite property (it THROWS if the direct route is entered). The
 *    fail-closed arms therefore drive the transaction directly and inject the
 *    receipt through `ctx.irBodyRouteAuditSession`, which is the exact field
 *    the production path reads.
 */

import { describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { IrDirectFunctionBodyReceiptAudit } from "../src/codegen/legacy-body-audit.js";
import {
  MultiPreparedCallablePublication,
  type MultiPreparedProgramCallableComponent,
} from "../src/codegen/multi-prepared-callable-publication.js";
import { compileMulti } from "../src/index.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationReport } from "../src/ir/integration-report.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { createPendingPreparedProgramComponentReceipt } from "../src/ir/prepared-component-publication.js";
import type { WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const CROSS_SOURCE_FILES = {
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

const STANDALONE_OPTIONS = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone" as const,
  trackIrOutcomes: true,
};

function preparedRows(outcomes: readonly IrObservedOutcome[] | undefined): readonly IrObservedOutcome[] {
  return (outcomes ?? []).filter((outcome) => outcome.preparedComponentId !== undefined);
}

/** One source, one terminal, one component: the smallest publishable transaction. */
function stageSingleTerminalPublication(input: {
  readonly directBodyReceipts: number;
  readonly ownBodyPatches: number;
  readonly withAuditSession: boolean;
}): {
  readonly publication: MultiPreparedCallablePublication<Record<string, never>>;
  readonly ctx: CodegenContext;
  readonly unitId: IrUnitId;
} {
  const ast = analyzeMultiSource(CROSS_SOURCE_FILES, "./entry.ts");
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory(ast.sourceFiles, { checker: ast.checker, entrySource: ast.entryFile }),
  );
  const sourceFile = ast.sourceFiles.find((candidate) => candidate.fileName.endsWith("dep.ts"))!;
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "add",
  )!;
  const unitId = identity.unitIdByDeclaration.get(declaration)! as IrUnitId;
  const sourceId = identity.sourceIdBySourceFile.get(sourceFile)!;
  const preparedComponentId = "prepared-component:issue-5299";
  const existing: WasmFunction = { name: "add", typeIdx: 0, locals: [], body: [], exported: false };
  const replacement: WasmFunction = { name: "add", typeIdx: 0, locals: [], body: [], exported: false };
  const receipt = createPendingPreparedProgramComponentReceipt({
    preparedComponentId,
    terminalUnitIds: [unitId],
    report: { compiled: [], errors: [] } satisfies IrIntegrationReport,
    patches: Array.from({ length: input.ownBodyPatches }, () => ({
      entry: {},
      artifactUnitId: unitId,
      terminalOwnerUnitId: unitId,
      funcIdx: 0,
      existing,
      replacement,
      finalBody: [],
    })),
    assertCurrent: () => {},
    prepareSeal: () => ({
      kind: "prepared-program-abi-pending-scope" as const,
      scopeId: preparedComponentId,
      terminalUnitIds: [unitId],
    }),
    scopePublicationState: () => "prepared" as const,
    abortScope: () => {},
  });
  const component: MultiPreparedProgramCallableComponent = {
    preparedComponentId,
    units: [{ sourceFile, sourceId, unitId, legacyName: "add", declaration }],
    pendingReceipt: receipt,
    assertPreflightCurrent: () => {},
  };
  const audit: IrDirectFunctionBodyReceiptAudit = Object.freeze({
    sourceId,
    countsByUnitId: new Map(input.directBodyReceipts === 0 ? [] : [[unitId, input.directBodyReceipts]]),
    violations: [],
    physicalRootUnitIds: new Set<IrUnitId>(),
  });
  const ctx = {
    irCompiledFuncs: [],
    irOutcomes: [],
    irProgramCallablePreparedUnitIds: undefined,
    standalone: true,
    wasi: false,
    ...(input.withAuditSession ? { irBodyRouteAuditSession: { directFunctionBodyReceiptAudit: () => audit } } : {}),
  } as unknown as CodegenContext;
  const publication = new MultiPreparedCallablePublication<Record<string, never>>({
    ctx,
    sourceFiles: [sourceFile],
    terminalByUnitId: identity.terminalByUnitId,
    components: [component],
  });
  publication.sealBodyBoundary({});
  publication.recordSkippedUnitIds(sourceFile, [unitId]);
  return { publication, ctx, unitId };
}

describe("#5299 prepared-callable rows carry the receipt triple", () => {
  it("publishes (1, 0, 1) on every prepared row of a cross-source standalone program", async () => {
    const result = await compileMulti(CROSS_SOURCE_FILES, "./entry.ts", STANDALONE_OPTIONS);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const rows = preparedRows(result.irOutcomes);
    // Anti-vacuity: the assertions below say nothing if the route never ran.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        {
          unitId: row.unitId,
          prepareAttempts: row.prepareAttempts,
          directBodyEmissions: row.directBodyEmissions,
          irBodyEmissions: row.irBodyEmissions,
          legacyBodyEmitted: row.legacyBodyEmitted,
          irBodyEmitted: row.irBodyEmitted,
        },
        `prepared row ${row.unitId} must carry an exact (1, 0, 1) triple`,
      ).toEqual({
        unitId: row.unitId,
        prepareAttempts: 1,
        directBodyEmissions: 0,
        irBodyEmissions: 1,
        // The booleans are the counters' projection, not independent literals.
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
  }, 120_000);

  it("keeps the row identity and kind it published before the triple existed", async () => {
    const result = await compileMulti(CROSS_SOURCE_FILES, "./entry.ts", STANDALONE_OPTIONS);

    const rows = preparedRows(result.irOutcomes);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.kind === "emitted" && row.stage === "patch" && row.backend === "wasmgc")).toBe(true);
    expect(rows.every((row) => row.target === "standalone" && row.unitKind === "function")).toBe(true);
  }, 120_000);

  it("derives the triple from the claimed token and the direct receipt ledger", () => {
    const { publication, unitId } = stageSingleTerminalPublication({
      directBodyReceipts: 0,
      ownBodyPatches: 1,
      withAuditSession: true,
    });

    const prepared = publication.prepareCommit();

    expect(prepared.finalOutcomes).toEqual([
      expect.objectContaining({
        unitId,
        prepareAttempts: 1,
        directBodyEmissions: 0,
        irBodyEmissions: 1,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      }),
    ]);
  });

  it("fails closed, publishing nothing, when a prepared unit also has a direct body receipt", () => {
    const { publication, ctx, unitId } = stageSingleTerminalPublication({
      directBodyReceipts: 1,
      ownBodyPatches: 1,
      withAuditSession: true,
    });

    expect(() => publication.prepareCommit()).toThrow(
      new RegExp(`${unitId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} recorded 1 direct body receipts`),
    );
    expect(ctx.irOutcomes).toEqual([]);
    expect(ctx.irCompiledFuncs).toEqual([]);
    expect(ctx.irProgramCallablePreparedUnitIds).toBeUndefined();
  });

  it("fails closed when the claimed token holds no own-body patch for the terminal", () => {
    const { publication, ctx } = stageSingleTerminalPublication({
      directBodyReceipts: 0,
      ownBodyPatches: 0,
      withAuditSession: true,
    });

    expect(() => publication.prepareCommit()).toThrow(/claims emission with 0 exact IR body patches/);
    expect(ctx.irOutcomes).toEqual([]);
  });

  it("states no counters at all when the direct-body receipt ledger was never allocated", () => {
    // The deliberate boundary: no ledger means no measurement, and a fabricated
    // `directBodyEmissions: 0` would be exactly the unmeasured claim this row
    // set exists to stop making. A future change that guesses zeros here — or
    // that starts publishing a partial triple — turns this red.
    const { publication } = stageSingleTerminalPublication({
      directBodyReceipts: 0,
      ownBodyPatches: 1,
      withAuditSession: false,
    });

    const row = publication.prepareCommit().finalOutcomes?.[0];

    expect(row?.legacyBodyEmitted).toBe(false);
    expect(row?.irBodyEmitted).toBe(true);
    expect(row?.prepareAttempts).toBeUndefined();
    expect(row?.directBodyEmissions).toBeUndefined();
    expect(row?.irBodyEmissions).toBeUndefined();
  });

  it("still aborts every receipt when a row is rejected after the tokens are claimed", () => {
    const { publication, ctx } = stageSingleTerminalPublication({
      directBodyReceipts: 1,
      ownBodyPatches: 1,
      withAuditSession: true,
    });
    // The rows are now built AFTER the token loop, so this is the ordering the
    // reorder had to preserve: a rejection there must still leave the owner a
    // transaction it can abort, exactly as a failing take already did.
    expect(() => publication.prepareCommit()).toThrow(/direct body receipts/);

    expect(() => publication.abort()).not.toThrow();
    expect(ctx.irOutcomes).toEqual([]);
  });

  it("publishes no callable prefix when the outcome prefix already owns a prepared unit", () => {
    const { publication, ctx } = stageSingleTerminalPublication({
      directBodyReceipts: 0,
      ownBodyPatches: 1,
      withAuditSession: true,
    });
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_CALLABLE_PUBLICATION", "existing-outcome");

    expect(() => publication.prepareCommit()).toThrow(/terminal outcome prefix already owns/);
    expect(ctx.irOutcomes).toEqual([]);
    vi.unstubAllEnvs();
  });
});
