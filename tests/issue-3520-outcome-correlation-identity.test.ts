// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  type IrOverlayIdentityPlan,
} from "../src/codegen/ir-overlay-identity.js";
import { auditIrSkippedFunctionSlots, reconcileIrOverlayOutcomes } from "../src/codegen/ir-overlay-outcomes.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationError, IrIntegrationReport, IrIntegrationTerminalEvidence } from "../src/ir/integration.js";
import type { IrObservedOutcome, IrPreparationFailure } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type { IrSelection } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

type TerminalSelection = Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;

interface Fixture {
  readonly context: IrPlanningIdentityContext;
  readonly sources: ReadonlyMap<string, ts.SourceFile>;
  readonly planned: ReadonlyMap<string, PlannedSource>;
}

interface PlannedSource {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly selection: TerminalSelection;
}

function fixture(files: ReadonlyMap<string, string>): Fixture {
  const roots = [...files.keys()];
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const sources = new Map(roots.map((fileName) => [fileName, program.getSourceFile(fileName)!] as const));
  const sourceFiles = [...sources.values()];
  const context = buildIrPlanningIdentityContext(
    buildIrUnitInventory(sourceFiles, { checker, entrySource: sources.get(roots[0]!)! }),
  );
  const planned = new Map<string, PlannedSource>();
  for (const [fileName, sourceFile] of sources) {
    const maps = buildIrOverlayIdentityMaps(sourceFile, checker, context);
    const identityPlan = planIrOverlayByIdentity(
      sourceFile,
      context,
      { experimentalIR: true, trackFallbacks: true },
      maps,
    );
    planned.set(fileName, {
      sourceFile,
      identityPlan,
      selection: identityPlan.selectionProjection.selection,
    });
  }
  return { context, sources, planned };
}

function functionUnitId(current: Fixture, fileName: string, functionName: string): IrUnitId {
  const sourceFile = current.sources.get(fileName);
  const declaration = sourceFile?.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  );
  const unitId = declaration && current.context.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error(`missing unit ID for ${fileName}:${functionName}`);
  return unitId;
}

function patched(unitId: IrUnitId, legacyName: string): IrIntegrationTerminalEvidence {
  return { kind: "patched", unitId, legacyName };
}

function failed(unitId: IrUnitId, legacyName: string): IrIntegrationTerminalEvidence {
  const outcome: IrPreparationFailure = {
    kind: "invariant",
    code: "verifier-failure",
    stage: "verify",
    detail: `${legacyName} failed verification`,
  };
  const error: IrIntegrationError = {
    func: legacyName,
    message: outcome.detail,
    kind: "verify",
    outcome,
  };
  return { kind: "failed", unitId, legacyName, error };
}

function reconcile(
  planned: PlannedSource,
  terminalEvidence: readonly IrIntegrationTerminalEvidence[],
  options: {
    readonly compiled?: readonly string[];
    readonly initialSelection?: TerminalSelection;
    readonly preparedSelection?: TerminalSelection;
    readonly preparationFailuresByUnitId?: ReadonlyMap<IrUnitId, IrPreparationFailure>;
  } = {},
) {
  const errors = terminalEvidence.flatMap((event) => (event.kind === "failed" ? [event.error] : []));
  const report: IrIntegrationReport = {
    compiled:
      options.compiled ?? terminalEvidence.flatMap((event) => (event.kind === "patched" ? [event.legacyName] : [])),
    errors,
    terminalEvidence,
  };
  return reconcileIrOverlayOutcomes({
    sourceFile: planned.sourceFile,
    identityPlan: planned.identityPlan,
    initialSelection: options.initialSelection ?? planned.selection,
    preparedSelection: options.preparedSelection ?? planned.selection,
    preparationFailuresByUnitId: options.preparationFailuresByUnitId ?? new Map(),
    skippedBodyUnitIds: new Set(),
    report,
    existingOutcomes: [],
    target: "gc",
  });
}

function outcomeFor(outcomes: readonly IrObservedOutcome[], unitId: IrUnitId): IrObservedOutcome {
  const outcome = outcomes.find((candidate) => candidate.unitId === unitId);
  if (!outcome) throw new Error(`missing observed outcome for ${unitId}`);
  return outcome;
}

describe("#3520 exact-ID terminal outcome correlation", () => {
  it("does not let the same label from another source satisfy the local owner", () => {
    const current = fixture(
      new Map([
        ["/repo/a.ts", "export function same(value: number): number { return value + 1; }"],
        ["/repo/b.ts", "export function same(value: number): number { return value + 2; }"],
      ]),
    );
    const a = current.planned.get("/repo/a.ts")!;
    const aId = functionUnitId(current, "/repo/a.ts", "same");
    const bId = functionUnitId(current, "/repo/b.ts", "same");

    expect(aId).not.toBe(bId);
    expect(reconcile(a, [patched(bId, "same")]).outcomes).toEqual([
      expect.objectContaining({
        unitId: aId,
        kind: "invariant",
        code: "selection-preparation-mismatch",
        irBodyEmitted: false,
      }),
    ]);
  });

  it("reports duplicate patched and patched-plus-failed evidence before preparation precedence", () => {
    const current = fixture(
      new Map([["/repo/owner.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const owner = current.planned.get("/repo/owner.ts")!;
    const ownerId = functionUnitId(current, "/repo/owner.ts", "owner");
    const earlierFailure: IrPreparationFailure = {
      kind: "unsupported",
      code: "late-preparation-unsupported",
      stage: "resolve",
      detail: "an earlier precedence branch must not hide duplicate evidence",
    };

    for (const evidence of [
      [patched(ownerId, "owner"), patched(ownerId, "owner")],
      [patched(ownerId, "owner"), failed(ownerId, "owner")],
    ]) {
      const result = reconcile(owner, evidence, {
        preparationFailuresByUnitId: new Map([[ownerId, earlierFailure]]),
      });
      expect(outcomeFor(result.outcomes, ownerId)).toMatchObject({
        kind: "invariant",
        code: "duplicate-unit-outcome",
        stage: "patch",
        irBodyEmitted: false,
      });
    }
  });

  it("turns foreign and leftover terminal evidence into structural invariants", () => {
    const current = fixture(
      new Map([
        [
          "/repo/local.ts",
          "export function kept(value: number): number { return value + 1; }\n" +
            "export function dropped(value: number): number { return value + 2; }",
        ],
        ["/repo/foreign.ts", "export function foreign(value: number): number { return value + 3; }"],
      ]),
    );
    const local = current.planned.get("/repo/local.ts")!;
    const keptId = functionUnitId(current, "/repo/local.ts", "kept");
    const droppedId = functionUnitId(current, "/repo/local.ts", "dropped");
    const foreignId = functionUnitId(current, "/repo/foreign.ts", "foreign");

    const foreign = reconcile(local, [patched(keptId, "kept"), patched(foreignId, "foreign")]);
    expect(foreign.outcomes).toHaveLength(2);
    for (const unitId of [keptId, droppedId]) {
      expect(outcomeFor(foreign.outcomes, unitId)).toMatchObject({
        kind: "invariant",
        code: "selection-preparation-mismatch",
        irBodyEmitted: false,
      });
    }

    const preparedSelection: TerminalSelection = {
      ...local.selection,
      funcs: new Set(["kept"]),
    };
    const leftover = reconcile(local, [patched(keptId, "kept"), patched(droppedId, "dropped")], {
      preparedSelection,
    });
    expect(outcomeFor(leftover.outcomes, keptId)).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    expect(outcomeFor(leftover.outcomes, droppedId)).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
      irBodyEmitted: false,
    });
  });

  it("does not treat compiled-name telemetry as terminal patch evidence", () => {
    const current = fixture(
      new Map([["/repo/telemetry.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const owner = current.planned.get("/repo/telemetry.ts")!;
    const ownerId = functionUnitId(current, "/repo/telemetry.ts", "owner");
    const result = reconcile(owner, [], { compiled: ["owner"] });

    expect(outcomeFor(result.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "missing-terminal-outcome",
      irBodyEmitted: false,
    });
  });

  it("keeps inventory-canonical output when terminal evidence order reverses", () => {
    const current = fixture(
      new Map([
        [
          "/repo/order.ts",
          "export function first(value: number): number { return value + 1; }\n" +
            "export function second(value: number): number { return value + 2; }",
        ],
      ]),
    );
    const ordered = current.planned.get("/repo/order.ts")!;
    const firstId = functionUnitId(current, "/repo/order.ts", "first");
    const secondId = functionUnitId(current, "/repo/order.ts", "second");
    const evidence = [patched(firstId, "first"), patched(secondId, "second")];

    const forward = reconcile(ordered, evidence);
    const reversed = reconcile(ordered, [...evidence].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.outcomes.map((outcome) => outcome.unitId)).toEqual([firstId, secondId]);
    expect(forward.outcomes).toEqual([
      expect.objectContaining({ unitId: firstId, kind: "emitted", irBodyEmitted: true }),
      expect.objectContaining({ unitId: secondId, kind: "emitted", irBodyEmitted: true }),
    ]);
  });

  it("certifies skipped legacy slots only from exact terminal evidence", () => {
    const current = fixture(
      new Map([
        ["/repo/local.ts", "export function same(value: number): number { return value + 1; }"],
        ["/repo/foreign.ts", "export function same(value: number): number { return value + 2; }"],
      ]),
    );
    const local = current.planned.get("/repo/local.ts")!;
    const localId = functionUnitId(current, "/repo/local.ts", "same");
    const foreignId = functionUnitId(current, "/repo/foreign.ts", "same");
    const skippedFunctionUnitIds = new Set([localId]);
    const audit = (terminalEvidence: readonly IrIntegrationTerminalEvidence[], compiled: readonly string[] = []) =>
      auditIrSkippedFunctionSlots({
        sourceFile: local.sourceFile,
        identityPlan: local.identityPlan,
        preparedSelection: local.selection,
        skippedFunctionUnitIds,
        report: {
          compiled,
          errors: terminalEvidence.flatMap((event) => (event.kind === "failed" ? [event.error] : [])),
          terminalEvidence,
        },
      });

    expect(audit([patched(localId, "same")])).toEqual([]);
    expect(audit([], ["same"])).toEqual([
      expect.objectContaining({
        unitId: localId,
        failure: expect.objectContaining({ kind: "invariant", code: "unpatched-slot" }),
      }),
    ]);
    expect(audit([patched(foreignId, "same")])).toEqual([
      expect.objectContaining({
        unitId: localId,
        failure: expect.objectContaining({ kind: "invariant", code: "selection-preparation-mismatch" }),
      }),
    ]);
    expect(audit([patched(localId, "same"), patched(localId, "same")])).toEqual([
      expect.objectContaining({
        unitId: localId,
        failure: expect.objectContaining({ kind: "invariant", code: "duplicate-unit-outcome" }),
      }),
    ]);
    expect(audit([failed(localId, "same")])).toEqual([
      expect.objectContaining({
        unitId: localId,
        failure: expect.objectContaining({ kind: "invariant", code: "verifier-failure" }),
      }),
    ]);
  });
});
