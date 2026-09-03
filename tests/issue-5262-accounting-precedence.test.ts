// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5262 / #5263) Precedence pins for R2 body-emission accounting.
 *
 * Three properties, each of which a plausible "simplification" of the fix would
 * silently break:
 *
 * 1. (#5263) A unit listed in `ownedElsewhereUnitIds` yields NEITHER a row nor a
 *    diagnostic — reconcile cannot see the prepared-callable publication, so
 *    every conclusion it reaches about that unit is stale by construction.
 * 2. (#5262, ASYMMETRY) A non-invariant row that fails accounting is still
 *    REPLACED. These arms are the only detector for a unit that took neither
 *    body route or both; turning them into notes would be green-washing.
 * 3. (#5262, ROOT CAUSE) A row that is ALREADY an invariant keeps its
 *    root-cause `code`, carries the accounting evidence as an attached note,
 *    and still surfaces that evidence in `diagnostics`.
 */
import { describe, expect, it } from "vitest";

import {
  buildIrOverlayIdentityMaps,
  planIrOverlayByIdentity,
  type IrOverlayIdentityPlan,
} from "../src/codegen/ir-overlay-identity.js";
import { reconcileIrOverlayOutcomes } from "../src/codegen/ir-overlay-outcomes.js";
import type { IrDirectFunctionBodyReceiptAudit } from "../src/codegen/legacy-body-audit.js";
import { bodyAccountingFailureOf } from "../src/ir/body-accounting-note.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import type { IrIntegrationReport, IrIntegrationTerminalEvidence } from "../src/ir/integration.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type { IrSelection } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

type TerminalSelection = Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;

interface PlannedSource {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly selection: TerminalSelection;
  readonly context: IrPlanningIdentityContext;
}

const FILE_NAME = "/repo/owner.ts";
const SOURCE = "export function owner(value: number): number { return value + 1; }";

function plan(): PlannedSource {
  const files = new Map([[FILE_NAME, SOURCE]]);
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
  const program = ts.createProgram([FILE_NAME], options, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(FILE_NAME)!;
  const context = buildIrPlanningIdentityContext(
    buildIrUnitInventory([sourceFile], { checker, entrySource: sourceFile }),
  );
  const maps = buildIrOverlayIdentityMaps(sourceFile, checker, context);
  const identityPlan = planIrOverlayByIdentity(
    sourceFile,
    context,
    { experimentalIR: true, trackFallbacks: true },
    maps,
  );
  return { sourceFile, identityPlan, selection: identityPlan.selectionProjection.selection, context };
}

function ownerUnitId(planned: PlannedSource): IrUnitId {
  const declaration = planned.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "owner",
  )!;
  return planned.context.unitIdByDeclaration.get(declaration)!;
}

function receipts(
  planned: PlannedSource,
  countsByUnitId: ReadonlyMap<IrUnitId, number>,
): IrDirectFunctionBodyReceiptAudit {
  return {
    sourceId: planned.context.sourceIdBySourceFile.get(planned.sourceFile)!,
    countsByUnitId,
    violations: [],
  };
}

function reconcile(
  planned: PlannedSource,
  terminalEvidence: readonly IrIntegrationTerminalEvidence[],
  options: {
    readonly preparedSelection?: TerminalSelection;
    readonly directFunctionBodyReceiptAudit?: IrDirectFunctionBodyReceiptAudit;
    readonly ownedElsewhereUnitIds?: ReadonlySet<IrUnitId>;
  } = {},
) {
  const report: IrIntegrationReport = {
    compiled: terminalEvidence.flatMap((event) => (event.kind === "patched" ? [event.legacyName] : [])),
    errors: [],
    terminalEvidence,
  };
  return reconcileIrOverlayOutcomes({
    sourceFile: planned.sourceFile,
    identityPlan: planned.identityPlan,
    initialSelection: planned.selection,
    preparedSelection: options.preparedSelection ?? planned.selection,
    preparationFailuresByUnitId: new Map(),
    skippedBodyUnitIds: new Set(),
    ...(options.directFunctionBodyReceiptAudit
      ? { directFunctionBodyReceiptAudit: options.directFunctionBodyReceiptAudit }
      : {}),
    ...(options.ownedElsewhereUnitIds ? { ownedElsewhereUnitIds: options.ownedElsewhereUnitIds } : {}),
    report,
    existingOutcomes: [],
    target: "gc",
  });
}

/** A selection with the terminal removed, so reconcile reaches `unsupported`. */
function withoutOwner(planned: PlannedSource): TerminalSelection {
  return { ...planned.selection, funcs: [] };
}

function rowFor(outcomes: readonly IrObservedOutcome[], unitId: IrUnitId): IrObservedOutcome | undefined {
  return outcomes.find((outcome) => outcome.unitId === unitId);
}

describe("#5262 / #5263 R2 accounting precedence", () => {
  it("(#5263) produces neither a row nor a diagnostic for a unit owned elsewhere", () => {
    const planned = plan();
    const unitId = ownerUnitId(planned);
    const audit = receipts(planned, new Map());

    // Control: without the skip set, this is exactly the shape that failed every
    // standalone multi-source compile — an `unsupported` row upgraded to a
    // `body-emission-evidence` invariant over zero direct receipts.
    const owned = reconcile(planned, [], {
      preparedSelection: withoutOwner(planned),
      directFunctionBodyReceiptAudit: audit,
    });
    expect(rowFor(owned.outcomes, unitId)).toMatchObject({ kind: "invariant", code: "body-emission-evidence" });
    expect(owned.diagnostics.join("\n")).toContain("body-emission-evidence");

    const elsewhere = reconcile(planned, [], {
      preparedSelection: withoutOwner(planned),
      directFunctionBodyReceiptAudit: audit,
      ownedElsewhereUnitIds: new Set([unitId]),
    });
    expect(rowFor(elsewhere.outcomes, unitId)).toBeUndefined();
    expect(elsewhere.diagnostics).toEqual([]);
  });

  it("(#5262) still REPLACES a non-invariant row that fails accounting", () => {
    const planned = plan();
    const unitId = ownerUnitId(planned);

    // `unsupported` root cause + zero direct receipts. This detector must keep
    // firing: if it ever degrades to an attached note the row stays
    // `unsupported`, drops out of the invariant diagnostic push, and a real
    // corruption goes silent.
    const result = reconcile(planned, [], {
      preparedSelection: withoutOwner(planned),
      directFunctionBodyReceiptAudit: receipts(planned, new Map()),
    });
    const row = rowFor(result.outcomes, unitId)!;
    expect(row).toMatchObject({ kind: "invariant", code: "body-emission-evidence", directBodyEmissions: 0 });
    expect(bodyAccountingFailureOf(row)).toBeUndefined();
    expect(result.diagnostics.join("\n")).toContain("IR outcome invariant [body-emission-evidence]");
  });

  it("(#5262) keeps the root cause on an invariant row and reports the accounting note beside it", () => {
    const planned = plan();
    const unitId = ownerUnitId(planned);

    // A duplicate direct receipt is a genuine `receiptFailure`. The row's root
    // cause is `duplicate-unit-outcome`-free here: it reaches an invariant on
    // its own (no terminal evidence at all, legacy body emitted), so the
    // accounting evidence must ride alongside rather than take the code slot.
    const result = reconcile(planned, [], {
      directFunctionBodyReceiptAudit: receipts(planned, new Map([[unitId, 2]])),
    });
    const row = rowFor(result.outcomes, unitId)!;
    expect(row.kind).toBe("invariant");
    expect(row.code).not.toBe("body-emission-evidence");
    const note = bodyAccountingFailureOf(row);
    expect(note).toMatchObject({ kind: "invariant", code: "body-emission-evidence" });
    expect(note?.detail).toContain("impossible count 2");
    // The evidence must not vanish from the diagnostic channel just because it
    // lost the headline.
    expect(result.diagnostics.some((line) => line.startsWith("IR body-emission accounting note for owner:"))).toBe(
      true,
    );
  });
});
