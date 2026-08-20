// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ClassDeclaration, ClassExpression, Node } from "typescript";
import type { IrClassId, IrClassRecord, IrSourceId, IrSourceRecord, IrUnitId, IrUnitKind } from "../ir/identity.js";
import type { IrObservedOutcome } from "../ir/outcomes.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { ProgramAbiDerivedUnitRecord } from "../ir/program-abi.js";
import { IR_COMPILE_ROUTE_MANIFEST, type IrCompileRoute } from "../ir/standalone-route-manifest.js";
import type { CompileTargetProfile } from "../target-profile.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

export type IrLegacyBodyUnitDisposition =
  | "legacy-ast-entry"
  | "terminal-ir"
  | "terminal-legacy"
  | "owned-support-ir-owner"
  | "owned-support-legacy-owner"
  | "owned-support-unresolved-owner"
  | "unowned-support"
  | "unresolved-terminal";

export type IrDerivedBodyUnitDisposition =
  | "derived-ir-owner"
  | "derived-legacy-owner"
  | "derived-unresolved-owner"
  | "derived-unowned";

export type IrBodyRouteAuditViolationCode =
  | "duplicate-outcome-unit"
  | "unknown-outcome-unit"
  | "missing-terminal-evidence"
  | "missing-legacy-entry-evidence"
  | "unresolved-legacy-entry"
  | "unknown-legacy-class"
  | "duplicate-derived-unit"
  | "unknown-derived-source"
  | "unknown-derived-parent"
  | "unknown-derived-owner";

export interface IrBodyRouteAuditViolation {
  readonly code: IrBodyRouteAuditViolationCode;
  readonly detail: string;
  readonly unitId?: IrUnitId;
}

export type IrLegacyBodyEntryPoint =
  | "compileDeclarations"
  | "compileModuleInitBody"
  | "compileFunctionBody"
  | "compileClassBodies"
  | "compileNestedFunctionDeclaration"
  | "compileNestedClassDeclaration"
  | "compileLiftedClosureBody"
  | "compileArrowAsClosure"
  | "compileStatement"
  | "compileExpression";

/** One physical entry into the direct AST body dispatcher. */
export interface IrLegacyBodyEntry {
  readonly target: CompileTargetProfile["target"];
  readonly entryPoint: IrLegacyBodyEntryPoint;
  readonly bodyName: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly sourceId?: IrSourceId;
  readonly unitId?: IrUnitId;
  readonly classId?: IrClassId;
  readonly unitKind?: IrUnitKind;
  readonly terminalOwnerId?: IrUnitId | null;
  readonly count: number;
}

/** Exhaustive source-inventory row, reconciled with physical legacy entries. */
export interface IrBodyRouteDisposition {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly unitKind: IrUnitKind;
  readonly terminal: boolean;
  readonly terminalOwnerId: IrUnitId | null;
  readonly disposition: IrLegacyBodyUnitDisposition;
}

export interface IrDerivedBodyRouteDisposition extends ProgramAbiDerivedUnitRecord {
  readonly disposition: IrDerivedBodyUnitDisposition;
}

export type IrBodyRouteSource = Pick<IrSourceRecord, "id" | "kind" | "order" | "sourceKey">;

/**
 * Opt-in physical-route evidence for the standalone IR cutover.
 *
 * Unlike `irOutcomes`, this records entry into the legacy AST dispatch itself
 * and covers support/nested units from the exhaustive R1 inventory. It is
 * observational only: recording never selects, skips, or patches a body.
 */
export interface IrBodyRouteAudit {
  readonly route: IrCompileRoute;
  readonly target: CompileTargetProfile["target"];
  readonly graph: "single" | "multi";
  readonly generator: "generateModule" | "generateMultiModule";
  readonly sources: readonly IrBodyRouteSource[];
  readonly classes: readonly IrClassRecord[];
  readonly sourceCount: number;
  readonly classCount: number;
  readonly allUnitCount: number;
  readonly terminalUnitCount: number;
  readonly ownedSupportUnitCount: number;
  readonly unownedSupportUnitCount: number;
  readonly legacyEntries: readonly IrLegacyBodyEntry[];
  readonly dispositions: readonly IrBodyRouteDisposition[];
  readonly derivedUnits: readonly IrDerivedBodyRouteDisposition[];
  readonly violations: readonly IrBodyRouteAuditViolation[];
  readonly structurallyComplete: boolean;
  readonly unattributedLegacyEntryCount: number;
}

function sourcePosition(node: Node): { file: string; line: number; column: number } {
  const sourceFile = node.getSourceFile();
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  return { file: sourceFile.fileName, line: pos.line + 1, column: pos.character + 1 };
}

function nearestInventoryUnit(identity: IrPlanningIdentityContext, node: Node): IrUnitId | undefined {
  for (let current: Node | undefined = node; current; current = current.parent) {
    const unitId = identity.unitIdByDeclaration.get(current);
    if (unitId !== undefined) return unitId;
  }
  return undefined;
}

function outcomeRoute(outcome: IrObservedOutcome | undefined): "ir" | "legacy" | "unresolved" {
  if (!outcome) return "unresolved";
  if (outcome.legacyBodyEmitted) return "legacy";
  if (outcome.irBodyEmitted) return "ir";
  return "unresolved";
}

/** Per-codegen-session recorder; allocated only with `trackIrOutcomes`. */
export class IrBodyRouteAuditSession {
  readonly #identity: IrPlanningIdentityContext;
  readonly #target: CompileTargetProfile["target"];
  readonly #compileRoute: IrCompileRoute;
  readonly #seenFrames = new WeakSet<FunctionContext>();
  readonly #entries = new Map<string, IrLegacyBodyEntry>();
  #route?: {
    readonly graph: "single" | "multi";
    readonly generator: "generateModule" | "generateMultiModule";
  };

  constructor(
    identity: IrPlanningIdentityContext,
    target: CompileTargetProfile["target"],
    compileRoute: IrCompileRoute,
  ) {
    this.#identity = identity;
    this.#target = target;
    this.#compileRoute = compileRoute;
  }

  registerGenerator(graph: "single" | "multi", generator: "generateModule" | "generateMultiModule"): void {
    const expected = IR_COMPILE_ROUTE_MANIFEST[this.#compileRoute];
    if (expected.graph !== graph || expected.generator !== generator) {
      throw new Error(
        `IR body-route audit route ${this.#compileRoute} expected ${expected.graph}/${expected.generator}, ` +
          `received ${graph}/${generator}`,
      );
    }
    const prior = this.#route;
    if (prior && (prior.graph !== graph || prior.generator !== generator)) {
      throw new Error(
        `IR body-route audit changed generator from ${prior.graph}/${prior.generator} to ${graph}/${generator}`,
      );
    }
    this.#route = Object.freeze({ graph, generator });
  }

  recordFrame(entryPoint: IrLegacyBodyEntryPoint, fctx: FunctionContext, node: Node): void {
    if (this.#seenFrames.has(fctx)) return;
    this.#seenFrames.add(fctx);
    if (fctx.name === "__module_init") return;
    this.#record(entryPoint, fctx.name, node);
  }

  recordRoot(entryPoint: IrLegacyBodyEntryPoint, bodyName: string, node: Node): void {
    this.#record(entryPoint, bodyName, node);
  }

  /** Record the generic expression dispatcher without growing its budget-constrained driver. */
  enterExpression(fctx: FunctionContext, node: Node, currentDepth: number): number {
    this.recordFrame("compileExpression", fctx, node);
    return currentDepth + 1;
  }

  #record(entryPoint: IrLegacyBodyEntryPoint, bodyName: string, node: Node): void {
    const sourceFile = node.getSourceFile();
    const sourceId = this.#identity.sourceIdBySourceFile.get(sourceFile);
    const unitId =
      nearestInventoryUnit(this.#identity, node) ??
      (entryPoint === "compileModuleInitBody"
        ? this.#identity.moduleInitUnitIdBySourceFile.get(node.getSourceFile())
        : undefined);
    const classId = this.#identity.classIdByDeclaration.get(node as ClassDeclaration | ClassExpression);
    const unit = unitId === undefined ? undefined : this.#identity.unitByUnitId.get(unitId);
    const source =
      sourceId === undefined ? undefined : this.#identity.inventory.sources.find((row) => row.id === sourceId);
    const position = { ...sourcePosition(node), ...(source === undefined ? {} : { file: source.sourceKey }) };
    const key = [
      entryPoint,
      bodyName,
      sourceId ?? "",
      unitId ?? "",
      position.file,
      position.line,
      position.column,
    ].join("\0");
    const prior = this.#entries.get(key);
    this.#entries.set(
      key,
      Object.freeze({
        target: this.#target,
        entryPoint,
        bodyName,
        ...position,
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(unitId === undefined ? {} : { unitId }),
        ...(classId === undefined ? {} : { classId }),
        ...(unit === undefined
          ? {}
          : {
              unitKind: unit.kind,
              terminalOwnerId: unit.terminalOwnerId,
            }),
        count: (prior?.count ?? 0) + 1,
      }),
    );
  }

  snapshot(
    outcomes: readonly IrObservedOutcome[] = [],
    derivedUnitRecords: Iterable<ProgramAbiDerivedUnitRecord> = [],
  ): IrBodyRouteAudit {
    if (!this.#route) throw new Error("IR body-route audit was not registered with a generator");
    const inventory = this.#identity.inventory;
    const violations: IrBodyRouteAuditViolation[] = [];
    const legacyEntryIds = new Set(
      [...this.#entries.values()].flatMap((entry) => (entry.unitId === undefined ? [] : [entry.unitId])),
    );
    const outcomesById = new Map<IrUnitId, IrObservedOutcome>();
    for (const outcome of outcomes) {
      if (outcome.unitId === undefined || !this.#identity.terminalByUnitId.has(outcome.unitId)) {
        violations.push({
          code: "unknown-outcome-unit",
          detail: `${outcome.displayName} has no exact terminal inventory identity`,
          ...(outcome.unitId === undefined ? {} : { unitId: outcome.unitId }),
        });
        continue;
      }
      if (outcomesById.has(outcome.unitId)) {
        violations.push({
          code: "duplicate-outcome-unit",
          detail: `terminal ${outcome.unitId} produced more than one outcome`,
          unitId: outcome.unitId,
        });
        continue;
      }
      outcomesById.set(outcome.unitId, outcome);
    }
    const dispositions = inventory.allUnits.map((unit): IrBodyRouteDisposition => {
      let disposition: IrLegacyBodyUnitDisposition;
      if (legacyEntryIds.has(unit.id)) {
        disposition = "legacy-ast-entry";
      } else if (unit.terminal) {
        const outcome = outcomesById.get(unit.id);
        const route = outcomeRoute(outcome);
        disposition = route === "ir" ? "terminal-ir" : route === "legacy" ? "terminal-legacy" : "unresolved-terminal";
        if (route === "legacy") {
          violations.push({
            code: "missing-legacy-entry-evidence",
            detail: `terminal ${unit.id} reports a legacy body without entering an audited direct-body root`,
            unitId: unit.id,
          });
        } else if (route === "unresolved") {
          violations.push({
            code: "missing-terminal-evidence",
            detail: `terminal ${unit.id} has neither a resolved IR outcome nor a physical legacy entry`,
            unitId: unit.id,
          });
        }
      } else if (unit.terminalOwnerId === null) {
        disposition = "unowned-support";
      } else {
        const route = legacyEntryIds.has(unit.terminalOwnerId)
          ? "legacy"
          : outcomeRoute(outcomesById.get(unit.terminalOwnerId));
        disposition =
          route === "ir"
            ? "owned-support-ir-owner"
            : route === "legacy"
              ? "owned-support-legacy-owner"
              : "owned-support-unresolved-owner";
      }
      return Object.freeze({
        sourceId: unit.sourceId,
        unitId: unit.id,
        unitKind: unit.kind,
        terminal: unit.terminal,
        terminalOwnerId: unit.terminalOwnerId,
        disposition,
      });
    });
    const knownSources = new Set(inventory.sources.map((source) => source.id));
    const knownUnits = new Set(inventory.allUnits.map((unit) => unit.id));
    const derivedById = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
    for (const record of derivedUnitRecords) {
      if (derivedById.has(record.id)) {
        violations.push({
          code: "duplicate-derived-unit",
          detail: `derived unit ${record.id} occurs more than once`,
          unitId: record.id,
        });
        continue;
      }
      derivedById.set(record.id, record);
    }
    const sourceOrder = new Map(inventory.sources.map((source) => [source.id, source.order]));
    const derivedUnits = [...derivedById.values()]
      .sort(
        (left, right) =>
          (sourceOrder.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) -
            (sourceOrder.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      )
      .map((record): IrDerivedBodyRouteDisposition => {
        if (!knownSources.has(record.sourceId)) {
          violations.push({
            code: "unknown-derived-source",
            detail: `derived unit ${record.id} references source ${record.sourceId} outside the inventory`,
            unitId: record.id,
          });
        }
        if (!knownUnits.has(record.parentId) && !derivedById.has(record.parentId)) {
          violations.push({
            code: "unknown-derived-parent",
            detail: `derived unit ${record.id} references unknown parent ${record.parentId}`,
            unitId: record.id,
          });
        }
        const owner = record.terminalOwnerId;
        if (owner !== null && !this.#identity.terminalByUnitId.has(owner)) {
          violations.push({
            code: "unknown-derived-owner",
            detail: `derived unit ${record.id} references unknown terminal owner ${owner}`,
            unitId: record.id,
          });
        }
        const route =
          owner === null ? "unresolved" : legacyEntryIds.has(owner) ? "legacy" : outcomeRoute(outcomesById.get(owner));
        return Object.freeze({
          ...record,
          disposition:
            owner === null
              ? "derived-unowned"
              : route === "ir"
                ? "derived-ir-owner"
                : route === "legacy"
                  ? "derived-legacy-owner"
                  : "derived-unresolved-owner",
        });
      });
    const supportUnits = inventory.allUnits.filter((unit) => !unit.terminal);
    const entries = Object.freeze([...this.#entries.values()]);
    const knownClasses = new Set(inventory.classes.map((record) => record.id));
    for (const entry of entries) {
      if (entry.classId !== undefined && !knownClasses.has(entry.classId)) {
        violations.push({
          code: "unknown-legacy-class",
          detail: `${entry.entryPoint} ${entry.bodyName} references class ${entry.classId} outside the inventory`,
        });
      }
      if (
        entry.sourceId === undefined ||
        (entry.unitId === undefined && entry.classId === undefined && entry.entryPoint !== "compileDeclarations")
      ) {
        violations.push({
          code: "unresolved-legacy-entry",
          detail: `${entry.entryPoint} ${entry.bodyName} has no exact source/unit/class identity`,
          ...(entry.unitId === undefined ? {} : { unitId: entry.unitId }),
        });
      }
    }
    const exactSources = Object.freeze(
      inventory.sources.map(({ id, kind, order, sourceKey }) => Object.freeze({ id, kind, order, sourceKey })),
    );
    const exactClasses = Object.freeze(inventory.classes.map((record) => Object.freeze({ ...record })));
    const exactViolations = Object.freeze(violations.map((violation) => Object.freeze(violation)));
    return Object.freeze({
      route: this.#compileRoute,
      target: this.#target,
      graph: this.#route.graph,
      generator: this.#route.generator,
      sources: exactSources,
      classes: exactClasses,
      sourceCount: inventory.sources.length,
      classCount: inventory.classes.length,
      allUnitCount: inventory.allUnits.length,
      terminalUnitCount: inventory.terminalUnits.length,
      ownedSupportUnitCount: supportUnits.filter((unit) => unit.terminalOwnerId !== null).length,
      unownedSupportUnitCount: supportUnits.filter((unit) => unit.terminalOwnerId === null).length,
      legacyEntries: entries,
      dispositions: Object.freeze(dispositions),
      derivedUnits: Object.freeze(derivedUnits),
      violations: exactViolations,
      structurallyComplete: exactViolations.length === 0,
      unattributedLegacyEntryCount: entries.filter(
        (entry) =>
          entry.unitId === undefined && entry.classId === undefined && entry.entryPoint !== "compileDeclarations",
      ).length,
    });
  }
}

/** Freeze source, derived-ABI, outcome, and physical-entry evidence at the publication boundary. */
export function snapshotLegacyBodyAudit(ctx: CodegenContext): IrBodyRouteAudit | undefined {
  return ctx.irBodyRouteAuditSession?.snapshot(ctx.irOutcomes, ctx.programAbiSession?.derivedUnitRecords());
}
