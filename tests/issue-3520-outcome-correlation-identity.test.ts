// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  type IrOverlayIdentityPlan,
} from "../src/codegen/ir-overlay-identity.js";
import { auditIrSkippedFunctionSlots, reconcileIrOverlayOutcomes } from "../src/codegen/ir-overlay-outcomes.js";
import type { IrDirectFunctionBodyReceiptAudit } from "../src/codegen/legacy-body-audit.js";
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

function functionUnitId(current: Fixture, fileName: string, functionName: string, occurrence = 0): IrUnitId {
  const sourceFile = current.sources.get(fileName);
  const declaration = sourceFile?.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
  )[occurrence];
  const unitId = declaration && current.context.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error(`missing unit ID for ${fileName}:${functionName}#${occurrence}`);
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
  return { kind: "failed", unitId, legacyName, error, diagnosticVisibility: "report" };
}

function outcomeOnlyFailed(unitId: IrUnitId, legacyName: string): IrIntegrationTerminalEvidence {
  const outcome: IrPreparationFailure = {
    kind: "unsupported",
    code: "late-preparation-unsupported",
    stage: "resolve",
    detail: `${legacyName} failed final-context preparation`,
  };
  const error: IrIntegrationError = {
    func: legacyName,
    message: outcome.detail,
    kind: "resolve",
    outcome,
  };
  return {
    kind: "failed",
    unitId,
    legacyName,
    error,
    errors: [],
    diagnosticVisibility: "outcome-only",
  };
}

function reconcile(
  planned: PlannedSource,
  terminalEvidence: readonly IrIntegrationTerminalEvidence[],
  options: {
    readonly compiled?: readonly string[];
    readonly initialSelection?: TerminalSelection;
    readonly preparedSelection?: TerminalSelection;
    readonly preparationFailuresByUnitId?: ReadonlyMap<IrUnitId, IrPreparationFailure>;
    readonly directFunctionBodyReceiptAudit?: IrDirectFunctionBodyReceiptAudit;
    readonly existingOutcomes?: readonly IrObservedOutcome[];
    readonly skippedBodyUnitIds?: ReadonlySet<IrUnitId>;
  } = {},
) {
  const errors = terminalEvidence.flatMap((event) =>
    event.kind === "failed" && event.diagnosticVisibility === "report" ? [event.error] : [],
  );
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
    skippedBodyUnitIds: options.skippedBodyUnitIds ?? new Set(),
    ...(options.directFunctionBodyReceiptAudit
      ? { directFunctionBodyReceiptAudit: options.directFunctionBodyReceiptAudit }
      : {}),
    report,
    existingOutcomes: options.existingOutcomes ?? [],
    target: "gc",
  });
}

function directReceiptAudit(
  planned: PlannedSource,
  countsByUnitId: ReadonlyMap<IrUnitId, number>,
  violations: IrDirectFunctionBodyReceiptAudit["violations"] = [],
): IrDirectFunctionBodyReceiptAudit {
  const sourceId = planned.identityPlan.identityContext.sourceIdBySourceFile.get(planned.sourceFile);
  if (!sourceId) throw new Error(`missing source identity for ${planned.sourceFile.fileName}`);
  return { sourceId, countsByUnitId, violations };
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

  it("accounts an unpatched R2 terminal as one preparation attempt and no body emission", () => {
    const current = fixture(
      new Map([["/repo/unpatched.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const planned = current.planned.get("/repo/unpatched.ts")!;
    const ownerId = functionUnitId(current, "/repo/unpatched.ts", "owner");
    const result = reconcile(planned, [], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map()),
      skippedBodyUnitIds: new Set([ownerId]),
    });

    expect(outcomeFor(result.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "unpatched-slot",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 0,
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
  });

  it("allows a post-prepared attempted IR patch on an invariant only without direct fallback", () => {
    const current = fixture(
      new Map([["/repo/post-prepared.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const planned = current.planned.get("/repo/post-prepared.ts")!;
    const ownerId = functionUnitId(current, "/repo/post-prepared.ts", "owner");
    const receipts = directReceiptAudit(planned, new Map());
    const emitted = outcomeFor(
      reconcile(planned, [patched(ownerId, "owner")], { directFunctionBodyReceiptAudit: receipts }).outcomes,
      ownerId,
    );
    const result = reconcile(planned, [patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: receipts,
      existingOutcomes: [emitted],
    });

    expect(outcomeFor(result.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "duplicate-unit-outcome",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 1,
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
  });

  it("fails closed on missing, duplicate, and foreign R2 body receipts", () => {
    const current = fixture(
      new Map([["/repo/receipts.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const planned = current.planned.get("/repo/receipts.ts")!;
    const ownerId = functionUnitId(current, "/repo/receipts.ts", "owner");

    const duplicateDirect = reconcile(planned, [patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map([[ownerId, 2]])),
    });
    expect(outcomeFor(duplicateDirect.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 2,
      irBodyEmissions: 1,
    });

    const foreignDirect = reconcile(planned, [patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map([["ir-unit:foreign:owner" as IrUnitId, 1]])),
    });
    expect(outcomeFor(foreignDirect.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 1,
    });

    const missingDirectEmitted = reconcile(planned, [patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map()),
    });
    expect(outcomeFor(missingDirectEmitted.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 1,
    });

    const duplicateIr = reconcile(planned, [patched(ownerId, "owner"), patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map()),
    });
    expect(outcomeFor(duplicateIr.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 2,
    });

    const fallback = fixture(
      new Map([["/repo/missing-direct.ts", "export function fallback(value: number = 1): number { return value; }"]]),
    );
    const fallbackPlan = fallback.planned.get("/repo/missing-direct.ts")!;
    const fallbackId = functionUnitId(fallback, "/repo/missing-direct.ts", "fallback");
    const missingDirect = reconcile(fallbackPlan, [], {
      directFunctionBodyReceiptAudit: directReceiptAudit(fallbackPlan, new Map()),
    });
    expect(outcomeFor(missingDirect.outcomes, fallbackId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 0,
    });

    const patchedFallback = reconcile(fallbackPlan, [patched(fallbackId, "fallback")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(fallbackPlan, new Map([[fallbackId, 1]])),
    });
    expect(outcomeFor(patchedFallback.outcomes, fallbackId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 1,
      irBodyEmissions: 1,
    });
  });

  it("publishes replacement accounting invariants and suppresses only unchanged report-visible failures", () => {
    const current = fixture(
      new Map([["/repo/diagnostic.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const planned = current.planned.get("/repo/diagnostic.ts")!;
    const ownerId = functionUnitId(current, "/repo/diagnostic.ts", "owner");
    const corruptedAudit = directReceiptAudit(planned, new Map([[ownerId, 1]]), [
      {
        code: "foreign-direct-function-body-receipt",
        detail: "injected exact receipt mismatch",
        unitId: ownerId,
      },
    ]);

    for (const evidence of [outcomeOnlyFailed(ownerId, "owner"), failed(ownerId, "owner")]) {
      const replaced = reconcile(planned, [evidence], {
        directFunctionBodyReceiptAudit: corruptedAudit,
      });
      expect(outcomeFor(replaced.outcomes, ownerId)).toMatchObject({
        kind: "invariant",
        code: "body-emission-evidence",
      });
      expect(replaced.diagnostics).toEqual([
        expect.stringContaining("IR outcome invariant [body-emission-evidence] for owner"),
      ]);
    }

    const unchanged = reconcile(planned, [failed(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map()),
      skippedBodyUnitIds: new Set([ownerId]),
    });
    expect(outcomeFor(unchanged.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "verifier-failure",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 0,
    });
    expect(unchanged.diagnostics).toEqual([]);
  });

  it("excludes shadowed duplicate declarations without accepting their direct receipts", () => {
    const current = fixture(
      new Map([
        [
          "/repo/duplicates.ts",
          "function duplicate(value) { return value + 1; }\n" + "function duplicate(value) { return value + 2; }",
        ],
      ]),
    );
    const planned = current.planned.get("/repo/duplicates.ts")!;
    const shadowedId = functionUnitId(current, "/repo/duplicates.ts", "duplicate", 0);
    const physicalId = functionUnitId(current, "/repo/duplicates.ts", "duplicate", 1);
    const result = reconcile(planned, [], {
      directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map([[shadowedId, 1]])),
    });

    expect(outcomeFor(result.outcomes, shadowedId)).not.toHaveProperty("prepareAttempts");
    expect(outcomeFor(result.outcomes, physicalId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      prepareAttempts: 1,
      directBodyEmissions: 0,
      irBodyEmissions: 0,
      detail: expect.stringContaining(shadowedId),
    });
  });

  it("fails every source closed on unattributed direct receipt corruption", () => {
    const current = fixture(
      new Map([["/repo/unattributed.ts", "export function owner(value: number): number { return value + 1; }"]]),
    );
    const planned = current.planned.get("/repo/unattributed.ts")!;
    const ownerId = functionUnitId(current, "/repo/unattributed.ts", "owner");
    const audit: IrDirectFunctionBodyReceiptAudit = {
      ...directReceiptAudit(planned, new Map([[ownerId, 1]])),
      unattributedViolation: {
        code: "missing-direct-function-body-identity",
        detail: "an unattributed direct receipt cannot be assigned to one source",
      },
    };
    const result = reconcile(planned, [patched(ownerId, "owner")], {
      directFunctionBodyReceiptAudit: audit,
    });

    expect(outcomeFor(result.outcomes, ownerId)).toMatchObject({
      kind: "invariant",
      code: "body-emission-evidence",
      detail: expect.stringContaining("unattributed direct receipt"),
    });
  });

  it("builds the R2 source population once across a multi-source graph", () => {
    const sourceCount = 12;
    const files = new Map(
      Array.from({ length: sourceCount }, (_, index) => [
        `/repo/source-${index}.ts`,
        `export function owner${index}(value: number): number { return value + ${index}; }`,
      ]),
    );
    const current = fixture(files);
    let terminalRecordReads = 0;
    const terminalUnits = new Proxy(current.context.inventory.terminalUnits, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) terminalRecordReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const identityContext: IrPlanningIdentityContext = {
      ...current.context,
      inventory: { ...current.context.inventory, terminalUnits },
    };

    for (let index = 0; index < sourceCount; index += 1) {
      const fileName = `/repo/source-${index}.ts`;
      const original = current.planned.get(fileName)!;
      const planned: PlannedSource = {
        ...original,
        identityPlan: { ...original.identityPlan, identityContext },
      };
      const unitId = functionUnitId(current, fileName, `owner${index}`);
      reconcile(planned, [], {
        directFunctionBodyReceiptAudit: directReceiptAudit(planned, new Map([[unitId, 1]])),
      });
    }

    // Outcome/evidence collection has two pre-existing source-local scans.
    // R2 accounting may add one graph-wide indexing pass, never another full
    // terminal census for every source.
    const terminalCount = current.context.inventory.terminalUnits.length;
    expect(terminalRecordReads).toBeLessThanOrEqual(terminalCount * (sourceCount * 2 + 1));
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
