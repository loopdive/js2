// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import {
  compareIrIdentity,
  getIrInventoryScannerMetadata,
  type IrClassId,
  type IrClassRecord,
  type IrSourceId,
  type IrTerminalUnitRecord,
  type IrUnitId,
  type IrUnitInventory,
  type IrUnitRecord,
} from "./identity.js";
import { collectModuleInitPopulation } from "./module-init.js";

/** Exact structural identity retained across a temporary name-keyed API. */
export interface IrLegacyUnitProjectionEntry {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
}

export type IrLegacyUnitProjectionInvariantCode =
  | "duplicate-unit-id"
  | "duplicate-legacy-name"
  | "invalid-legacy-name"
  | "missing-unit"
  | "missing-legacy-name"
  | "mismatched-pair"
  | "duplicate-result-correlation"
  | "foreign-result-correlation"
  | "unconsumed-result-correlation";

export class IrLegacyUnitProjectionInvariantError extends Error {
  constructor(
    readonly code: IrLegacyUnitProjectionInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "IrLegacyUnitProjectionInvariantError";
  }
}

/** A name-keyed legacy result carrying its structural owner sidecar. */
export interface IrLegacyNamedUnitResult<TResult> extends IrLegacyUnitProjectionEntry {
  readonly result: TResult;
}

/**
 * Exact AST identity seam consumed by source planning.
 *
 * The inventory remains the single semantic population. These maps are only
 * validated views over the declarations encountered while that exact
 * inventory was scanned; no display-name or best-effort span join is used.
 * Synthetic inventory records without an AST declaration deliberately remain
 * absent from the declaration maps.
 */
export interface IrPlanningIdentityContext {
  readonly inventory: IrUnitInventory;
  readonly sourceIdBySourceFile: ReadonlyMap<ts.SourceFile, IrSourceId>;
  readonly sourceFileBySourceId: ReadonlyMap<IrSourceId, ts.SourceFile>;
  readonly unitIdByDeclaration: ReadonlyMap<ts.Node, IrUnitId>;
  readonly declarationByUnitId: ReadonlyMap<IrUnitId, ts.Node>;
  readonly unitByUnitId: ReadonlyMap<IrUnitId, IrUnitRecord>;
  readonly terminalByUnitId: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly classIdByDeclaration: ReadonlyMap<ts.ClassDeclaration | ts.ClassExpression, IrClassId>;
  readonly declarationByClassId: ReadonlyMap<IrClassId, ts.ClassDeclaration | ts.ClassExpression>;
  /** Module init is structurally owned by its source, not by an arbitrary AST anchor. */
  readonly moduleInitUnitIdBySourceId: ReadonlyMap<IrSourceId, IrUnitId>;
  readonly moduleInitUnitIdBySourceFile: ReadonlyMap<ts.SourceFile, IrUnitId>;
  /** Exact top-level statement population captured once for later stale-AST validation. */
  readonly moduleInitPopulationBySourceFile: ReadonlyMap<ts.SourceFile, readonly ts.Statement[]>;
}

export type IrPlanningIdentityInvariantCode =
  | "untracked-inventory"
  | "source-record-mismatch"
  | "duplicate-source-id"
  | "duplicate-source-file"
  | "duplicate-unit-id"
  | "unit-record-mismatch"
  | "duplicate-unit-declaration"
  | "missing-unit-declaration"
  | "duplicate-terminal-id"
  | "terminal-record-mismatch"
  | "invalid-terminal-owner"
  | "duplicate-class-id"
  | "class-record-mismatch"
  | "duplicate-class-declaration"
  | "missing-class-declaration"
  | "invalid-module-init"
  | "duplicate-module-init"
  | "unowned-planning-owner"
  | "missing-planning-owner";

export class IrPlanningIdentityInvariantError extends Error {
  constructor(
    readonly code: IrPlanningIdentityInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "IrPlanningIdentityInvariantError";
  }
}

/** Runtime read-only map: callers do not receive a mutable Map behind the type. */
class IrReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #backingMap: ReadonlyMap<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#backingMap = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#backingMap.size;
  }

  get(key: K): V | undefined {
    return this.#backingMap.get(key);
  }

  has(key: K): boolean {
    return this.#backingMap.has(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#backingMap) callbackfn.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[K, V]> {
    return this.#backingMap.entries();
  }

  keys(): MapIterator<K> {
    return this.#backingMap.keys();
  }

  values(): MapIterator<V> {
    return this.#backingMap.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#backingMap[Symbol.iterator]();
  }
}

function readonlyIdentityMap<K, V>(values: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new IrReadonlyMap(values);
}

function legacyProjectionInvariant(code: IrLegacyUnitProjectionInvariantCode, message: string): never {
  throw new IrLegacyUnitProjectionInvariantError(code, message);
}

function compareProjectionEntry(a: IrLegacyUnitProjectionEntry, b: IrLegacyUnitProjectionEntry): number {
  const identityOrder = compareIrIdentity(a.unitId, b.unitId);
  if (identityOrder !== 0) return identityOrder;
  return a.legacyName < b.legacyName ? -1 : a.legacyName > b.legacyName ? 1 : 0;
}

/**
 * Immutable one-to-one compatibility view for one exact active population.
 *
 * Every translating API returns the complete pair. Callers cannot obtain an
 * optional name and substitute a display/runtime label when correlation is
 * absent. Entries are canonicalized by structural identity independently of
 * producer insertion order; the raw directional maps remain private.
 */
export class IrLegacyUnitProjection {
  readonly entries: readonly IrLegacyUnitProjectionEntry[];
  readonly #entryByUnitId: ReadonlyMap<IrUnitId, IrLegacyUnitProjectionEntry>;
  readonly #entryByLegacyName: ReadonlyMap<string, IrLegacyUnitProjectionEntry>;

  /** @internal Construct through {@link buildIrLegacyUnitProjection}. */
  constructor(entries: readonly IrLegacyUnitProjectionEntry[]) {
    const canonical = entries.map((entry) => {
      if (typeof entry.legacyName !== "string" || entry.legacyName.length === 0) {
        return legacyProjectionInvariant(
          "invalid-legacy-name",
          "legacy unit projection names must be non-empty strings",
        );
      }
      return Object.freeze({ unitId: entry.unitId, legacyName: entry.legacyName });
    });
    canonical.sort(compareProjectionEntry);

    const entryByUnitId = new Map<IrUnitId, IrLegacyUnitProjectionEntry>();
    for (const entry of canonical) {
      if (entryByUnitId.has(entry.unitId)) {
        legacyProjectionInvariant(
          "duplicate-unit-id",
          `unit ${entry.unitId} occurs more than once in the legacy unit projection`,
        );
      }
      entryByUnitId.set(entry.unitId, entry);
    }

    const entryByLegacyName = new Map<string, IrLegacyUnitProjectionEntry>();
    for (const entry of canonical) {
      const previous = entryByLegacyName.get(entry.legacyName);
      if (previous) {
        legacyProjectionInvariant(
          "duplicate-legacy-name",
          `legacy name ${JSON.stringify(entry.legacyName)} maps to both ${previous.unitId} and ${entry.unitId}`,
        );
      }
      entryByLegacyName.set(entry.legacyName, entry);
    }

    this.entries = Object.freeze(canonical);
    this.#entryByUnitId = readonlyIdentityMap(entryByUnitId);
    this.#entryByLegacyName = readonlyIdentityMap(entryByLegacyName);
    Object.freeze(this);
  }

  /** Optional membership probe that retains the complete structural/name pair. */
  getByUnitId(unitId: IrUnitId): IrLegacyUnitProjectionEntry | undefined {
    return this.#entryByUnitId.get(unitId);
  }

  /** Optional membership probe that retains the complete structural/name pair. */
  getByLegacyName(legacyName: string): IrLegacyUnitProjectionEntry | undefined {
    return this.#entryByLegacyName.get(legacyName);
  }

  requireUnit(unitId: IrUnitId): IrLegacyUnitProjectionEntry {
    const entry = this.getByUnitId(unitId);
    if (!entry) {
      return legacyProjectionInvariant("missing-unit", `unit ${unitId} has no legacy unit projection`);
    }
    return entry;
  }

  requireLegacyName(legacyName: string): IrLegacyUnitProjectionEntry {
    const entry = this.getByLegacyName(legacyName);
    if (!entry) {
      return legacyProjectionInvariant(
        "missing-legacy-name",
        `legacy name ${JSON.stringify(legacyName)} has no structural unit projection`,
      );
    }
    return entry;
  }

  requirePair(pair: IrLegacyUnitProjectionEntry): IrLegacyUnitProjectionEntry {
    const byUnit = this.getByUnitId(pair.unitId);
    if (!byUnit) {
      return legacyProjectionInvariant("missing-unit", `unit ${pair.unitId} has no legacy unit projection`);
    }
    const byName = this.getByLegacyName(pair.legacyName);
    if (!byName) {
      return legacyProjectionInvariant(
        "missing-legacy-name",
        `legacy name ${JSON.stringify(pair.legacyName)} has no structural unit projection`,
      );
    }
    if (byUnit !== byName) {
      return legacyProjectionInvariant(
        "mismatched-pair",
        `unit ${pair.unitId} and legacy name ${JSON.stringify(pair.legacyName)} are not one projection pair`,
      );
    }
    return byUnit;
  }

  startResultCorrelation<TResult>(): IrLegacyUnitResultCorrelation<TResult> {
    return new IrLegacyUnitResultCorrelation<TResult>(this);
  }
}

/** Validate and canonicalize one active legacy compatibility population. */
export function buildIrLegacyUnitProjection(entries: readonly IrLegacyUnitProjectionEntry[]): IrLegacyUnitProjection {
  return new IrLegacyUnitProjection(entries);
}

/**
 * Exactly-once correlation for results returned by one projected legacy call.
 *
 * The result sidecar must carry both the original unit ID and the returned
 * legacy name. Completion rejects any active unit for which no result was
 * consumed; its output is ordered by the projection rather than event arrival.
 */
export class IrLegacyUnitResultCorrelation<TResult> {
  readonly #projection: IrLegacyUnitProjection;
  readonly #resultByUnitId = new Map<IrUnitId, IrLegacyNamedUnitResult<TResult>>();
  #completed: ReadonlyMap<IrUnitId, IrLegacyNamedUnitResult<TResult>> | undefined;

  /** @internal Start through {@link IrLegacyUnitProjection.startResultCorrelation}. */
  constructor(projection: IrLegacyUnitProjection) {
    this.#projection = projection;
  }

  consume(result: IrLegacyNamedUnitResult<TResult>): IrLegacyNamedUnitResult<TResult> {
    const entry = this.#projection.getByUnitId(result.unitId);
    if (!entry || entry.legacyName !== result.legacyName) {
      return legacyProjectionInvariant(
        "foreign-result-correlation",
        `legacy result ${result.unitId} / ${JSON.stringify(result.legacyName)} does not belong to this projection`,
      );
    }
    if (this.#resultByUnitId.has(result.unitId)) {
      return legacyProjectionInvariant(
        "duplicate-result-correlation",
        `legacy result ${JSON.stringify(result.legacyName)} was correlated more than once for unit ${result.unitId}`,
      );
    }
    const correlated = Object.freeze({
      unitId: result.unitId,
      legacyName: result.legacyName,
      result: result.result,
    });
    this.#resultByUnitId.set(result.unitId, correlated);
    return correlated;
  }

  complete(): ReadonlyMap<IrUnitId, IrLegacyNamedUnitResult<TResult>> {
    if (this.#completed) return this.#completed;
    const unconsumed = this.#projection.entries.filter((entry) => !this.#resultByUnitId.has(entry.unitId));
    if (unconsumed.length > 0) {
      return legacyProjectionInvariant(
        "unconsumed-result-correlation",
        `legacy results were not correlated for ${unconsumed
          .map((entry) => `${entry.unitId} / ${JSON.stringify(entry.legacyName)}`)
          .join(", ")}`,
      );
    }
    this.#completed = readonlyIdentityMap(
      new Map(this.#projection.entries.map((entry) => [entry.unitId, this.#resultByUnitId.get(entry.unitId)!])),
    );
    return this.#completed;
  }
}

function planningIdentityInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

/** Require an exact source object from the authoritative planning context. */
export function requireIrPlanningSourceId(
  identityContext: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
): IrSourceId {
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (sourceId) return sourceId;
  return planningIdentityInvariant(
    "source-record-mismatch",
    `source ${sourceFile.fileName} is not part of the authoritative IR planning context`,
  );
}

function requireIrPlanningTerminalRecord(
  identityContext: IrPlanningIdentityContext,
  sourceId: IrSourceId,
  terminalOwnerId: IrUnitId,
): IrTerminalUnitRecord {
  const terminal = identityContext.terminalByUnitId.get(terminalOwnerId);
  const inventoryRecord = identityContext.unitByUnitId.get(terminalOwnerId);
  if (!terminal || inventoryRecord !== terminal || !terminal.terminal || terminal.terminalOwnerId !== terminal.id) {
    return planningIdentityInvariant(
      "missing-planning-owner",
      `planning owner ${terminalOwnerId} is not an exact terminal inventory record`,
    );
  }
  if (terminal.sourceId !== sourceId) {
    return planningIdentityInvariant(
      "source-record-mismatch",
      `planning owner ${terminalOwnerId} belongs to source ${terminal.sourceId}, not ${sourceId}`,
    );
  }
  return terminal;
}

/**
 * Require the R0 terminal owner for an exact AST node.
 *
 * The nearest scanner-indexed unit boundary is authoritative. In particular,
 * an unowned support boundary must not fall through to an outer unit or the
 * source module-init unit. Module init is used only when no enclosing unit was
 * captured for the node at all.
 */
export function requireIrPlanningOwnerUnitId(identityContext: IrPlanningIdentityContext, node: ts.Node): IrUnitId {
  const sourceFile = node.getSourceFile();
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return planningIdentityInvariant(
      "source-record-mismatch",
      `source ${sourceId} does not resolve back to the exact planning SourceFile`,
    );
  }

  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const unitId = identityContext.unitIdByDeclaration.get(current);
    if (unitId === undefined) continue;

    const unit = identityContext.unitByUnitId.get(unitId);
    if (!unit || identityContext.declarationByUnitId.get(unitId) !== current) {
      return planningIdentityInvariant(
        "missing-planning-owner",
        `indexed declaration does not resolve to exact inventory unit ${unitId}`,
      );
    }
    if (unit.sourceId !== sourceId) {
      return planningIdentityInvariant(
        "source-record-mismatch",
        `indexed unit ${unitId} belongs to source ${unit.sourceId}, not ${sourceId}`,
      );
    }
    if (unit.terminalOwnerId === null) {
      return planningIdentityInvariant(
        "unowned-planning-owner",
        `indexed support unit ${unitId} has no R0 terminal owner`,
      );
    }
    if (unit.terminal && unit.terminalOwnerId !== unit.id) {
      return planningIdentityInvariant("missing-planning-owner", `terminal unit ${unit.id} does not own itself`);
    }
    return requireIrPlanningTerminalRecord(identityContext, sourceId, unit.terminalOwnerId).id;
  }

  const moduleInitUnitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  if (moduleInitUnitId === undefined || identityContext.moduleInitUnitIdBySourceId.get(sourceId) !== moduleInitUnitId) {
    return planningIdentityInvariant(
      "missing-planning-owner",
      `source ${sourceId} has no exact source-owned module-init planning unit`,
    );
  }
  const moduleInit = requireIrPlanningTerminalRecord(identityContext, sourceId, moduleInitUnitId);
  if (
    moduleInit.kind !== "module-init" ||
    moduleInit.observedKind !== "module-init" ||
    moduleInit.lexicalOwnerId !== null
  ) {
    return planningIdentityInvariant(
      "missing-planning-owner",
      `source-owned planning unit ${moduleInitUnitId} is not a structural module-init terminal`,
    );
  }
  return moduleInit.id;
}

/**
 * Validate and expose the exact declaration identities captured while one
 * inventory was built. Passing a rebuilt/copied inventory is rejected: source
 * planning must share the same population and record objects as outcome/ABI
 * planning rather than reconstructing a parallel name-keyed view.
 */
export function buildIrPlanningIdentityContext(inventory: IrUnitInventory): IrPlanningIdentityContext {
  const scanned = getIrInventoryScannerMetadata(inventory);
  if (!scanned) {
    return planningIdentityInvariant(
      "untracked-inventory",
      "IR planning identity requires the exact inventory returned by buildIrUnitInventory",
    );
  }

  if (scanned.sources.length !== inventory.sources.length) {
    return planningIdentityInvariant(
      "source-record-mismatch",
      `inventory has ${inventory.sources.length} sources but its scanner captured ${scanned.sources.length}`,
    );
  }

  const sourceIdBySourceFile = new Map<ts.SourceFile, IrSourceId>();
  const sourceFileBySourceId = new Map<IrSourceId, ts.SourceFile>();
  const moduleInitPopulationBySourceFile = new Map<ts.SourceFile, readonly ts.Statement[]>();
  for (let index = 0; index < inventory.sources.length; index++) {
    const source = inventory.sources[index]!;
    const scannedSource = scanned.sources[index]!;
    if (scannedSource.record !== source || scannedSource.sourceFile.fileName !== source.originalFileName) {
      return planningIdentityInvariant(
        "source-record-mismatch",
        `source ${index} no longer matches scanner record ${source.id}`,
      );
    }
    if (sourceFileBySourceId.has(source.id)) {
      return planningIdentityInvariant("duplicate-source-id", `source identity ${source.id} occurs more than once`);
    }
    if (sourceIdBySourceFile.has(scannedSource.sourceFile)) {
      return planningIdentityInvariant(
        "duplicate-source-file",
        `source file ${scannedSource.sourceFile.fileName} occurs more than once`,
      );
    }
    sourceIdBySourceFile.set(scannedSource.sourceFile, source.id);
    sourceFileBySourceId.set(source.id, scannedSource.sourceFile);
    const moduleInitPopulation = collectModuleInitPopulation(scannedSource.sourceFile);
    for (const statement of moduleInitPopulation) {
      if (statement.parent !== scannedSource.sourceFile || statement.getSourceFile() !== scannedSource.sourceFile) {
        return planningIdentityInvariant(
          "invalid-module-init",
          `module-init statement at ${statement.pos} is detached from source ${source.id}`,
        );
      }
    }
    moduleInitPopulationBySourceFile.set(scannedSource.sourceFile, Object.freeze(moduleInitPopulation));
  }

  const unitsById = new Map<IrUnitId, IrUnitRecord>();
  for (const unit of inventory.allUnits) {
    if (unitsById.has(unit.id)) {
      return planningIdentityInvariant("duplicate-unit-id", `unit identity ${unit.id} occurs more than once`);
    }
    if (!sourceFileBySourceId.has(unit.sourceId)) {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `unit ${unit.id} belongs to unknown source ${unit.sourceId}`,
      );
    }
    unitsById.set(unit.id, unit);
  }

  const terminalByUnitId = new Map<IrUnitId, IrTerminalUnitRecord>();
  const moduleInitUnitIdBySourceId = new Map<IrSourceId, IrUnitId>();
  const moduleInitUnitIdBySourceFile = new Map<ts.SourceFile, IrUnitId>();
  for (const terminal of inventory.terminalUnits) {
    if (terminalByUnitId.has(terminal.id)) {
      return planningIdentityInvariant(
        "duplicate-terminal-id",
        `terminal identity ${terminal.id} occurs more than once`,
      );
    }
    if (unitsById.get(terminal.id) !== terminal || !terminal.terminal || terminal.terminalOwnerId !== terminal.id) {
      return planningIdentityInvariant(
        "terminal-record-mismatch",
        `terminal ${terminal.id} is not the exact terminal record in allUnits`,
      );
    }
    terminalByUnitId.set(terminal.id, terminal);

    const moduleIdentity = terminal.kind === "module-init" || terminal.observedKind === "module-init";
    if (!moduleIdentity) continue;
    if (
      terminal.kind !== "module-init" ||
      terminal.observedKind !== "module-init" ||
      terminal.lexicalOwnerId !== null
    ) {
      return planningIdentityInvariant(
        "invalid-module-init",
        `module-init terminal ${terminal.id} does not have structural source ownership`,
      );
    }
    if (moduleInitUnitIdBySourceId.has(terminal.sourceId)) {
      return planningIdentityInvariant(
        "duplicate-module-init",
        `source ${terminal.sourceId} owns more than one module-init unit`,
      );
    }
    const sourceFile = sourceFileBySourceId.get(terminal.sourceId);
    if (!sourceFile) {
      return planningIdentityInvariant(
        "invalid-module-init",
        `module-init ${terminal.id} belongs to unknown source ${terminal.sourceId}`,
      );
    }
    moduleInitUnitIdBySourceId.set(terminal.sourceId, terminal.id);
    moduleInitUnitIdBySourceFile.set(sourceFile, terminal.id);
  }
  for (const unit of inventory.allUnits) {
    if (unit.terminal && terminalByUnitId.get(unit.id) !== unit) {
      return planningIdentityInvariant(
        "terminal-record-mismatch",
        `terminal allUnits record ${unit.id} is absent from terminalUnits`,
      );
    }
    if (unit.terminalOwnerId !== null && !terminalByUnitId.has(unit.terminalOwnerId)) {
      return planningIdentityInvariant(
        "invalid-terminal-owner",
        `unit ${unit.id} references unknown terminal owner ${unit.terminalOwnerId}`,
      );
    }
    if (unit.terminal && unit.containingTerminalOwnerId !== undefined) {
      const containing = terminalByUnitId.get(unit.containingTerminalOwnerId);
      if (
        unit.containingTerminalOwnerId === unit.id ||
        containing === undefined ||
        containing.sourceId !== unit.sourceId
      ) {
        return planningIdentityInvariant(
          "invalid-terminal-owner",
          `nested terminal ${unit.id} references invalid containing terminal ${unit.containingTerminalOwnerId}`,
        );
      }
    }
  }

  const unitIdByDeclaration = new Map<ts.Node, IrUnitId>();
  const declarationByUnitId = new Map<IrUnitId, ts.Node>();
  for (const entry of scanned.units) {
    if (unitsById.get(entry.record.id) !== entry.record || entry.record.kind === "module-init") {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `scanned declaration does not match inventory unit ${entry.record.id}`,
      );
    }
    if (
      sourceIdBySourceFile.get(entry.sourceFile) !== entry.record.sourceId ||
      entry.declaration.getSourceFile() !== entry.sourceFile
    ) {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `unit ${entry.record.id} declaration belongs to a different source`,
      );
    }
    const priorDeclarationId = unitIdByDeclaration.get(entry.declaration);
    if (priorDeclarationId !== undefined) {
      return planningIdentityInvariant(
        "duplicate-unit-declaration",
        `AST declaration maps to both ${priorDeclarationId} and ${entry.record.id}`,
      );
    }
    if (declarationByUnitId.has(entry.record.id)) {
      return planningIdentityInvariant(
        "duplicate-unit-declaration",
        `unit ${entry.record.id} maps to more than one AST declaration`,
      );
    }
    unitIdByDeclaration.set(entry.declaration, entry.record.id);
    declarationByUnitId.set(entry.record.id, entry.declaration);
  }
  for (const unit of inventory.allUnits) {
    if (unit.kind === "module-init") {
      if (declarationByUnitId.has(unit.id)) {
        return planningIdentityInvariant(
          "invalid-module-init",
          `module-init ${unit.id} must be owned by its source rather than an AST declaration`,
        );
      }
      continue;
    }
    if (!declarationByUnitId.has(unit.id) && unit.syntheticRole === undefined) {
      return planningIdentityInvariant(
        "missing-unit-declaration",
        `source unit ${unit.id} has no scanned AST declaration`,
      );
    }
  }

  const classesById = new Map<IrClassId, IrClassRecord>();
  for (const classRecord of inventory.classes) {
    if (classesById.has(classRecord.id)) {
      return planningIdentityInvariant("duplicate-class-id", `class identity ${classRecord.id} occurs more than once`);
    }
    if (!sourceFileBySourceId.has(classRecord.sourceId)) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `class ${classRecord.id} belongs to unknown source ${classRecord.sourceId}`,
      );
    }
    classesById.set(classRecord.id, classRecord);
  }

  const classIdByDeclaration = new Map<ts.ClassDeclaration | ts.ClassExpression, IrClassId>();
  const declarationByClassId = new Map<IrClassId, ts.ClassDeclaration | ts.ClassExpression>();
  for (const entry of scanned.classes) {
    if (classesById.get(entry.record.id) !== entry.record) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `scanned declaration does not match inventory class ${entry.record.id}`,
      );
    }
    if (
      sourceIdBySourceFile.get(entry.sourceFile) !== entry.record.sourceId ||
      entry.declaration.getSourceFile() !== entry.sourceFile
    ) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `class ${entry.record.id} declaration belongs to a different source`,
      );
    }
    const priorDeclarationId = classIdByDeclaration.get(entry.declaration);
    if (priorDeclarationId !== undefined) {
      return planningIdentityInvariant(
        "duplicate-class-declaration",
        `class declaration maps to both ${priorDeclarationId} and ${entry.record.id}`,
      );
    }
    if (declarationByClassId.has(entry.record.id)) {
      return planningIdentityInvariant(
        "duplicate-class-declaration",
        `class ${entry.record.id} maps to more than one AST declaration`,
      );
    }
    classIdByDeclaration.set(entry.declaration, entry.record.id);
    declarationByClassId.set(entry.record.id, entry.declaration);
  }
  for (const classRecord of inventory.classes) {
    if (!declarationByClassId.has(classRecord.id) && classRecord.syntheticRole === undefined) {
      return planningIdentityInvariant(
        "missing-class-declaration",
        `source class ${classRecord.id} has no scanned AST declaration`,
      );
    }
  }

  for (const terminal of inventory.terminalUnits) {
    if (terminal.containingTerminalOwnerId === undefined) continue;
    const classRecord =
      terminal.lexicalOwnerId === null ? undefined : classesById.get(terminal.lexicalOwnerId as IrClassId);
    if (
      terminal.observedKind !== "class-member" ||
      !classRecord ||
      classRecord.sourceId !== terminal.sourceId ||
      classRecord.lexicalOwnerId !== terminal.containingTerminalOwnerId
    ) {
      return planningIdentityInvariant(
        "invalid-terminal-owner",
        `nested terminal ${terminal.id} is detached from its enclosing class/component edge`,
      );
    }
  }

  return Object.freeze({
    inventory,
    sourceIdBySourceFile: readonlyIdentityMap(sourceIdBySourceFile),
    sourceFileBySourceId: readonlyIdentityMap(sourceFileBySourceId),
    unitIdByDeclaration: readonlyIdentityMap(unitIdByDeclaration),
    declarationByUnitId: readonlyIdentityMap(declarationByUnitId),
    unitByUnitId: readonlyIdentityMap(unitsById),
    terminalByUnitId: readonlyIdentityMap(terminalByUnitId),
    classIdByDeclaration: readonlyIdentityMap(classIdByDeclaration),
    declarationByClassId: readonlyIdentityMap(declarationByClassId),
    moduleInitUnitIdBySourceId: readonlyIdentityMap(moduleInitUnitIdBySourceId),
    moduleInitUnitIdBySourceFile: readonlyIdentityMap(moduleInitUnitIdBySourceFile),
    moduleInitPopulationBySourceFile: readonlyIdentityMap(moduleInitPopulationBySourceFile),
  });
}
