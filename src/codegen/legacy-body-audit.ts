// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ClassDeclaration, ClassExpression, Node, SourceFile } from "typescript";
import type { IrClassId, IrClassRecord, IrSourceId, IrSourceRecord, IrUnitId, IrUnitKind } from "../ir/identity.js";
import { nonExecutableOutcomeDefect, type IrObservedOutcome } from "../ir/outcomes.js";
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
  | "unjoined-non-executable-outcome"
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

/** Fail-closed diagnostics for exact top-level direct-body receipts. */
export type IrDirectFunctionBodyReceiptViolationCode =
  | "missing-direct-function-body-identity"
  | "foreign-direct-function-body-receipt"
  | "impossible-direct-function-body-receipt"
  | "duplicate-direct-function-body-receipt";

export interface IrDirectFunctionBodyReceiptViolation {
  readonly code: IrDirectFunctionBodyReceiptViolationCode;
  readonly detail: string;
  readonly unitId?: IrUnitId;
}

/**
 * Exact receipt census for the R2 free-function direct dispatcher.
 *
 * A count comes only from entering `compileFunctionBody`, never from a skip
 * set, a selector label, or a legacy name projection.
 */
export interface IrDirectFunctionBodyReceiptAudit {
  readonly sourceId: IrSourceId;
  readonly countsByUnitId: ReadonlyMap<IrUnitId, number>;
  /**
   * (#5308 R3) Exact direct-body receipts for this source's terminal
   * `class-member` units, kept in their OWN map. A class member's direct body
   * is emitted by `compileClassBodies`, never by `compileFunctionBody`
   * (`declarations.ts` calls the latter only for top-level, runtime-namespace
   * and CJS functions), so it can never appear in `countsByUnitId` — whose
   * contract is top-level free functions only and whose width
   * `tests/issue-5283-*` / `issue-5262-*` pin.
   */
  readonly classMemberCountsByUnitId: ReadonlyMap<IrUnitId, number>;
  /**
   * (#5308 R4) Direct-body receipts for this source's module-init terminal,
   * CLAMPED to 0 or 1 on purpose. The direct front end compiles module init
   * "more than once (discovery and final emission)" by design
   * (`declarations.ts` `compileModuleInitBody`, driven from `module-init-pass1`
   * and `module-init-pass2`), and pass 2 overwrites pass 1's context — so the
   * number of physical roots is a PASS count, not a body count. Measured
   * 2026-09-03 on the 35-case corpus: 3 gc / 1 standalone sources record two
   * roots for one emitted body. The question this map answers is therefore
   * "did the direct emitter emit this module-init body", which is the one the
   * compile-once ratio needs.
   */
  readonly moduleInitCountsByUnitId: ReadonlyMap<IrUnitId, number>;
  readonly violations: readonly IrDirectFunctionBodyReceiptViolation[];
  /** Graph-global corruption that cannot be safely assigned to one source. */
  readonly unattributedViolation?: IrDirectFunctionBodyReceiptViolation;
  /**
   * (#5283) Units of THIS source that physically entered an audited direct-body
   * root — the same superset `snapshot()`'s `legacyEntryIds` uses, so a row
   * built from it agrees with `missing-legacy-entry-evidence` by construction.
   * Wider than `countsByUnitId`, which is `compileFunctionBody` receipts for
   * top-level free functions only: this also carries `compileClassBodies`,
   * `compileModuleInitBody`, `compileStatement` and `compileExpression` roots,
   * which is what "did a direct pass run for this unit" actually asks.
   */
  readonly physicalRootUnitIds: ReadonlySet<IrUnitId>;
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

interface MutableDirectFunctionBodyReceiptIndex {
  readonly countsByUnitId: Map<IrUnitId, number>;
  readonly classMemberCountsByUnitId: Map<IrUnitId, number>;
  readonly moduleInitCountsByUnitId: Map<IrUnitId, number>;
  readonly violations: IrDirectFunctionBodyReceiptViolation[];
  readonly duplicateUnitIds: Set<IrUnitId>;
}

/** Per-codegen-session recorder; allocated only with `trackIrOutcomes`. */
export class IrBodyRouteAuditSession {
  readonly #identity: IrPlanningIdentityContext;
  readonly #target: CompileTargetProfile["target"];
  readonly #compileRoute: IrCompileRoute;
  readonly #sourceById: ReadonlyMap<IrSourceId, IrBodyRouteSource>;
  readonly #seenFrames = new WeakSet<FunctionContext>();
  readonly #entries = new Map<string, IrLegacyBodyEntry>();
  readonly #directFunctionBodyReceiptsBySourceId = new Map<IrSourceId, MutableDirectFunctionBodyReceiptIndex>();
  #unattributedDirectFunctionBodyReceiptViolation?: IrDirectFunctionBodyReceiptViolation;
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
    this.#sourceById = new Map(identity.inventory.sources.map((source) => [source.id, source]));
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

  /** Physical direct-body roots recorded for one entry point. */
  countRoots(entryPoint: IrLegacyBodyEntryPoint): number {
    return [...this.#entries.values()]
      .filter((entry) => entry.entryPoint === entryPoint)
      .reduce((total, entry) => total + entry.count, 0);
  }

  /** Record the generic expression dispatcher without growing its budget-constrained driver. */
  enterExpression(fctx: FunctionContext, node: Node, currentDepth: number): number {
    this.recordFrame("compileExpression", fctx, node);
    return currentDepth + 1;
  }

  /**
   * Return the exact direct-body receipts for one source's top-level function
   * terminals. This is intentionally a separate view from the broad route
   * audit: class/member and module-init dispatchers have their own R3/R4
   * accounting contracts and must not be inferred from a class-name root.
   */
  directFunctionBodyReceiptAudit(sourceFile: SourceFile): IrDirectFunctionBodyReceiptAudit {
    const sourceId = this.#identity.sourceIdBySourceFile.get(sourceFile);
    if (!sourceId || this.#identity.sourceFileBySourceId.get(sourceId) !== sourceFile) {
      throw new Error(
        `IR direct-body receipt source ${sourceFile.fileName} is outside the authoritative planning context`,
      );
    }
    const indexed = this.#directFunctionBodyReceiptsBySourceId.get(sourceId);
    const countsByUnitId = new Map(indexed?.countsByUnitId);
    const classMemberCountsByUnitId = new Map(indexed?.classMemberCountsByUnitId);
    const violations = [...(indexed?.violations ?? [])];
    for (const unitId of indexed?.duplicateUnitIds ?? []) {
      const count = countsByUnitId.get(unitId) ?? classMemberCountsByUnitId.get(unitId);
      violations.push(
        Object.freeze({
          code: "duplicate-direct-function-body-receipt",
          detail: `direct function-body receipt ${unitId} occurs ${count} times`,
          unitId,
        }),
      );
    }
    return Object.freeze({
      sourceId,
      countsByUnitId,
      classMemberCountsByUnitId,
      moduleInitCountsByUnitId: new Map(indexed?.moduleInitCountsByUnitId),
      violations: Object.freeze(violations),
      physicalRootUnitIds: this.#physicalRootUnitIds(sourceId),
      ...(this.#unattributedDirectFunctionBodyReceiptViolation
        ? { unattributedViolation: this.#unattributedDirectFunctionBodyReceiptViolation }
        : {}),
    });
  }

  /**
   * (#5283) Physical direct-body roots of one source, attributed from EXACT
   * inventory identity only. An entry's ambient `sourceId` is the source being
   * compiled when the root was entered, not proof that source owns the body —
   * the whole-program `__module_init` of a multi-source graph is exactly such
   * an entry (already reported as `unresolved-legacy-entry`), so it resolves to
   * no unit here and is attributed to nobody. Same shape as the
   * `moduleInitRootSourceIds` guard in `snapshot()`.
   */
  #physicalRootUnitIds(sourceId: IrSourceId): ReadonlySet<IrUnitId> {
    const rootUnitIds = new Set<IrUnitId>();
    for (const entry of this.#entries.values()) {
      if (entry.unitId === undefined) continue;
      if (this.#identity.unitByUnitId.get(entry.unitId)?.sourceId !== sourceId) continue;
      rootUnitIds.add(entry.unitId);
    }
    return rootUnitIds;
  }

  #directFunctionBodyReceiptIndex(sourceId: IrSourceId): MutableDirectFunctionBodyReceiptIndex {
    let indexed = this.#directFunctionBodyReceiptsBySourceId.get(sourceId);
    if (!indexed) {
      indexed = {
        countsByUnitId: new Map(),
        classMemberCountsByUnitId: new Map(),
        moduleInitCountsByUnitId: new Map(),
        violations: [],
        duplicateUnitIds: new Set(),
      };
      this.#directFunctionBodyReceiptsBySourceId.set(sourceId, indexed);
    }
    return indexed;
  }

  #recordDirectFunctionBodyReceiptViolation(
    sourceId: IrSourceId | undefined,
    code: IrDirectFunctionBodyReceiptViolationCode,
    detail: string,
    unitId?: IrUnitId,
  ): void {
    const violation = Object.freeze({ code, detail, ...(unitId === undefined ? {} : { unitId }) });
    if (sourceId !== undefined && this.#sourceById.has(sourceId)) {
      this.#directFunctionBodyReceiptIndex(sourceId).violations.push(violation);
      return;
    }
    this.#unattributedDirectFunctionBodyReceiptViolation ??= violation;
  }

  /**
   * (#5308) Exact terminal identity for one physical direct-body root of a
   * non-R2 kind, or `undefined` when the root is not that terminal's own body.
   *
   * The rejection is load-bearing, not defensive. `compileClassBodies` records
   * a WHOLE-CLASS root as well as a per-member one, and on a class with an
   * implicit constructor the class root resolves through `nearestInventoryUnit`
   * to the `class-implicit-constructor` unit — which is NOT terminal (measured
   * 2026-09-03). A census that trusted "attributed to some unit" would count
   * class scaffolding as that constructor's body and report compile-twice on a
   * unit that compiled once, the exact inflation #5283 closed in the other
   * direction.
   */
  #terminalBodyReceiptIdentity(
    entry: IrLegacyBodyEntry,
    observedKind: "class-member" | "module-init",
  ): { readonly unitId: IrUnitId; readonly sourceId: IrSourceId } | undefined {
    if (entry.unitId === undefined) return undefined;
    const terminal = this.#identity.terminalByUnitId.get(entry.unitId);
    if (!terminal || terminal.observedKind !== observedKind) return undefined;
    if (entry.sourceId === undefined || !this.#sourceById.has(entry.sourceId)) {
      this.#recordDirectFunctionBodyReceiptViolation(
        terminal.sourceId,
        "missing-direct-function-body-identity",
        `direct ${observedKind} body receipt ${JSON.stringify(entry.bodyName)} has no exact source identity`,
        entry.unitId,
      );
      return undefined;
    }
    if (
      terminal.sourceId !== entry.sourceId ||
      entry.unitKind !== terminal.kind ||
      entry.terminalOwnerId !== entry.unitId
    ) {
      this.#recordDirectFunctionBodyReceiptViolation(
        entry.sourceId,
        "foreign-direct-function-body-receipt",
        `direct ${observedKind} body receipt ${entry.unitId} does not match its exact terminal/source owner`,
        entry.unitId,
      );
      return undefined;
    }
    return { unitId: entry.unitId, sourceId: entry.sourceId };
  }

  /**
   * (#5308 R3) One physical `compileClassBodies` MEMBER root = one direct body.
   *
   * `compileClassBodies` records two kinds of root under one entry point: a
   * whole-class root at entry (node = the class declaration, recorded
   * unconditionally, before any member is compiled) and a per-member root from
   * `assertDirectClassBodyAllowed` (node = the member, recorded only after the
   * skip check declined). Only the second is a body receipt, and `classId` is
   * the exact discriminator: it is set precisely when the recorded node IS a
   * class declaration/expression.
   *
   * Measured 2026-09-03 on `tests/issue-3519-ir-outcomes.test.ts`
   * `class-initializers.ts`: a class with a static block has a TERMINAL
   * implicit constructor, and the whole-class root resolves to it through
   * `nearestInventoryUnit` even though that constructor's body was skipped and
   * IR-patched. Counting it reported `(1, 1, 1)` compile-twice on a unit that
   * compiled once — the inflation #5283 closed in the other direction, and the
   * exact case #5283's own comment predicted.
   *
   * **Stated residual:** an implicit constructor has no declaration node of its
   * own, so when it IS compiled directly its member root also carries the class
   * declaration and is not attributed either. Such a row reads `(1, 0, 0)`. The
   * audit refuses to assert a body it cannot tell apart from class scaffolding,
   * the same stance #5283 took for the anonymous-default-class rows whose roots
   * are the #3523 gap-1 unattributed-entry debt.
   */
  #indexClassMemberBodyReceipt(entry: IrLegacyBodyEntry): void {
    if (entry.classId !== undefined) return;
    const identity = this.#terminalBodyReceiptIdentity(entry, "class-member");
    if (!identity) return;
    const indexed = this.#directFunctionBodyReceiptIndex(identity.sourceId);
    const count = (indexed.classMemberCountsByUnitId.get(identity.unitId) ?? 0) + 1;
    if (!Number.isSafeInteger(count) || count <= 0) {
      this.#recordDirectFunctionBodyReceiptViolation(
        identity.sourceId,
        "impossible-direct-function-body-receipt",
        `direct class-member body receipt ${identity.unitId} has impossible count ${count}`,
        identity.unitId,
      );
      return;
    }
    indexed.classMemberCountsByUnitId.set(identity.unitId, count);
    if (count > 1) indexed.duplicateUnitIds.add(identity.unitId);
  }

  /**
   * (#5308 R4) Presence, not multiplicity — see `moduleInitCountsByUnitId`.
   * The direct front end enters this dispatcher once per PASS (discovery, then
   * final emission), and pass 2 replaces pass 1's context, so a second root is
   * the designed shape rather than a second body. Recording it as a duplicate
   * receipt would fail three corpus sources that emit exactly one body each.
   */
  #indexModuleInitBodyReceipt(entry: IrLegacyBodyEntry): void {
    const identity = this.#terminalBodyReceiptIdentity(entry, "module-init");
    if (!identity) return;
    this.#directFunctionBodyReceiptIndex(identity.sourceId).moduleInitCountsByUnitId.set(identity.unitId, 1);
  }

  #indexDirectBodyReceipt(entry: IrLegacyBodyEntry): void {
    if (entry.entryPoint === "compileClassBodies") {
      this.#indexClassMemberBodyReceipt(entry);
      return;
    }
    if (entry.entryPoint === "compileModuleInitBody") {
      this.#indexModuleInitBodyReceipt(entry);
      return;
    }
    if (entry.entryPoint !== "compileFunctionBody") return;
    const knownUnit = entry.unitId === undefined ? undefined : this.#identity.unitByUnitId.get(entry.unitId);
    const attributedSourceId =
      entry.sourceId !== undefined && this.#sourceById.has(entry.sourceId) ? entry.sourceId : knownUnit?.sourceId;

    // `compileFunctionBody` is also a shared wrapper for known support,
    // nested, CJS/runtime-namespace, and compiler-synthetic bodies. Exact
    // identities in those populations are outside #3521 and remain ignored.
    if (knownUnit && (!knownUnit.terminal || knownUnit.kind !== "top-level-function")) {
      if (
        entry.sourceId !== knownUnit.sourceId ||
        entry.unitKind !== knownUnit.kind ||
        entry.terminalOwnerId !== knownUnit.terminalOwnerId
      ) {
        this.#recordDirectFunctionBodyReceiptViolation(
          attributedSourceId,
          "foreign-direct-function-body-receipt",
          `out-of-scope direct function-body receipt ${entry.unitId} does not match its exact inventory identity`,
          entry.unitId,
        );
      }
      return;
    }
    if (entry.sourceId === undefined || entry.unitId === undefined) {
      this.#recordDirectFunctionBodyReceiptViolation(
        attributedSourceId,
        "missing-direct-function-body-identity",
        `direct function-body receipt ${JSON.stringify(entry.bodyName)} has no exact source/unit identity`,
        entry.unitId,
      );
      return;
    }
    const terminal = this.#identity.terminalByUnitId.get(entry.unitId);
    if (
      !terminal ||
      terminal.kind !== "top-level-function" ||
      terminal.observedKind !== "function" ||
      terminal.sourceId !== entry.sourceId ||
      entry.unitKind !== terminal.kind ||
      entry.terminalOwnerId !== entry.unitId
    ) {
      this.#recordDirectFunctionBodyReceiptViolation(
        attributedSourceId,
        "foreign-direct-function-body-receipt",
        `direct function-body receipt ${entry.unitId} does not match its exact terminal/source owner`,
        entry.unitId,
      );
      return;
    }
    const indexed = this.#directFunctionBodyReceiptIndex(entry.sourceId);
    const count = (indexed.countsByUnitId.get(entry.unitId) ?? 0) + 1;
    if (!Number.isSafeInteger(count) || count <= 0) {
      this.#recordDirectFunctionBodyReceiptViolation(
        entry.sourceId,
        "impossible-direct-function-body-receipt",
        `direct function-body receipt ${entry.unitId} has impossible count ${count}`,
        entry.unitId,
      );
      return;
    }
    indexed.countsByUnitId.set(entry.unitId, count);
    if (count > 1) indexed.duplicateUnitIds.add(entry.unitId);
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
    const source = sourceId === undefined ? undefined : this.#sourceById.get(sourceId);
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
    const entry = Object.freeze({
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
    });
    this.#entries.set(key, entry);
    this.#indexDirectBodyReceipt(entry);
  }

  /** Sources that own a module-init terminal, so cannot be "nothing to do". */
  #moduleInitTerminalSourceIds(): ReadonlySet<IrSourceId> {
    return new Set(
      this.#identity.inventory.terminalUnits.flatMap((unit) =>
        unit.observedKind === "module-init" ? [unit.sourceId] : [],
      ),
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
    // (#3523 R4 gap 4) Sources with a physical module-init body root, counted
    // ONLY from roots carrying exact terminal identity. A `compileModuleInitBody`
    // entry whose unit identity does not resolve is already reported as
    // `unresolved-legacy-entry`; its ambient `sourceId` is the source being
    // compiled at the time, not proof that THAT source owns the body. Measured
    // 2026-08-31: the whole-program `__module_init` of a multi-source graph is
    // exactly such an entry, so trusting its `sourceId` would report a spurious
    // second defect against an innocent empty dependency.
    const moduleInitRootSourceIds = new Set(
      [...this.#entries.values()].flatMap((entry) => {
        if (entry.entryPoint !== "compileModuleInitBody" || entry.unitId === undefined) return [];
        const terminal = this.#identity.inventory.terminalUnits.find((unit) => unit.id === entry.unitId);
        return terminal?.observedKind === "module-init" ? [terminal.sourceId] : [];
      }),
    );
    const outcomesById = new Map<IrUnitId, IrObservedOutcome>();
    const nonExecutableSourceIds = new Set<IrSourceId>();
    for (const outcome of outcomes) {
      // (#3523 R4 gap 4) A non-executable module init has no terminal unit to
      // join on, by contract. That is asserted here rather than skipped: the
      // source must genuinely own zero module-init terminals and zero physical
      // `compileModuleInitBody` roots, and must not already have such a row.
      // Anything else is a row claiming an absence the audit can see is false.
      if (outcome.kind === "non-executable") {
        const defect =
          nonExecutableOutcomeDefect(outcome) ??
          (outcome.sourceId === undefined
            ? "has no source identity"
            : nonExecutableSourceIds.has(outcome.sourceId)
              ? "is the second non-executable row for its source"
              : this.#moduleInitTerminalSourceIds().has(outcome.sourceId)
                ? "names a source that owns a module-init terminal"
                : moduleInitRootSourceIds.has(outcome.sourceId)
                  ? "names a source with a physical compileModuleInitBody root"
                  : undefined);
        if (defect) {
          violations.push({
            code: "unjoined-non-executable-outcome",
            detail: `non-executable module-init outcome for ${outcome.file} ${defect}`,
          });
        } else if (outcome.sourceId !== undefined) {
          nonExecutableSourceIds.add(outcome.sourceId);
        }
        continue;
      }
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
