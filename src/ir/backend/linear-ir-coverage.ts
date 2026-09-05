// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import {
  createIrSourceId,
  type IrSourceId,
  type IrSourceKind,
  type IrTerminalObservedKind,
  type IrTerminalUnitRecord,
  type IrUnitId,
  type IrUnitKind,
} from "../identity.js";
import { IrInvariantError } from "../outcomes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../planning-identity.js";

export const LINEAR_IR_COVERAGE_SCHEMA = "linear-ir-coverage-census-v1" as const;

export type LinearIrCoverageGenerationKind = "single-source" | "multi-source";
export type LinearIrCoverageStatus = "complete" | "generation-failed";
export type LinearIrCoverageNotAttemptedReason =
  | "selector-omitted"
  | "overlay-disabled"
  | "generation-aborted"
  | "multi-source-overlay-unimplemented";

export interface LinearIrCoverageSourceV1 {
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly kind: IrSourceKind;
  readonly order: number;
}

export type LinearIrCoverageOutcomeV1 =
  | { readonly kind: "compiled" }
  | { readonly kind: "rejected"; readonly reason: string; readonly detail?: string }
  | { readonly kind: "not-attempted"; readonly reason: LinearIrCoverageNotAttemptedReason };

export interface LinearIrCoverageOwnerV1 {
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly legacyName: string;
  readonly terminalKind: IrUnitKind;
  readonly observedKind: Extract<IrTerminalObservedKind, "function" | "class-member">;
  readonly outcome: LinearIrCoverageOutcomeV1;
}

export interface LinearIrCoverageCountsV1 {
  readonly sources: number;
  readonly owners: number;
  readonly compiled: number;
  readonly rejected: number;
  readonly notAttempted: number;
}

export interface LinearIrCoverageFailureV1 {
  readonly phase: string;
  readonly code: string;
  readonly detail: string;
}

export type LinearIrCoverageCensusV1 = Readonly<{
  readonly schema: typeof LINEAR_IR_COVERAGE_SCHEMA;
  readonly generationOrdinal: number;
  readonly generationKind: LinearIrCoverageGenerationKind;
  readonly entrySourceId: IrSourceId;
  readonly entrySourceKey: string;
  readonly status: LinearIrCoverageStatus;
  readonly sources: readonly LinearIrCoverageSourceV1[];
  readonly owners: readonly LinearIrCoverageOwnerV1[];
  readonly counts: LinearIrCoverageCountsV1;
  readonly failure?: LinearIrCoverageFailureV1;
}>;

/** Compiler-owned source identity retained only for one in-memory transaction. */
export interface LinearIrCoverageSourceDescriptor extends LinearIrCoverageSourceV1 {
  readonly sourceFile: object;
  readonly originalFileName: string;
}

/** Compiler-owned owner identity retained only for one in-memory transaction. */
export interface LinearIrCoverageOwnerDescriptor {
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly legacyName: string;
  readonly terminalKind: IrUnitKind;
  readonly observedKind: Extract<IrTerminalObservedKind, "function" | "class-member">;
  readonly declaration: object;
  readonly terminalRecord: object;
}

export interface LinearIrSourceOwner {
  readonly ownerUnitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.Node;
}

export interface LinearIrSourceOwnerIndex {
  readonly owners: readonly LinearIrSourceOwner[];
}

export interface PreparedLinearIrCoveragePopulation {
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly entrySource: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly identityContext: IrPlanningIdentityContext;
  readonly sources: readonly LinearIrCoverageSourceDescriptor[];
  readonly owners: readonly LinearIrCoverageOwnerDescriptor[];
}

export interface BeginLinearIrCoverageGenerationInput {
  readonly populationToken: object;
  readonly generationKind: LinearIrCoverageGenerationKind;
  readonly entrySourceId: IrSourceId;
  readonly entrySourceKey: string;
  readonly sources: readonly LinearIrCoverageSourceDescriptor[];
  readonly owners: readonly LinearIrCoverageOwnerDescriptor[];
}

export type LinearIrCoverageOwnerEvidence =
  | {
      readonly outcome: "compiled";
      readonly ownerUnitId: IrUnitId;
      readonly legacyName: string;
    }
  | {
      readonly outcome: "rejected";
      readonly ownerUnitId: IrUnitId;
      readonly legacyName: string;
      readonly rejection: { readonly func: string; readonly reason: string; readonly detail?: string };
    };

export interface FinalizeLinearIrCoverageGenerationInput {
  readonly populationToken: object;
  readonly status: LinearIrCoverageStatus;
  readonly ownerEvidence: readonly LinearIrCoverageOwnerEvidence[];
  readonly publicCompiled: readonly string[];
  readonly publicRejected: readonly { readonly func: string; readonly reason: string; readonly detail?: string }[];
  readonly unresolvedReason: LinearIrCoverageNotAttemptedReason;
  readonly failure?: LinearIrCoverageFailureV1;
}

export interface LinearIrCoverageCompatibilityEvidence {
  readonly ownerEvidence: readonly LinearIrCoverageOwnerEvidence[];
  readonly compiled: readonly string[];
  readonly rejected: readonly { readonly func: string; readonly reason: string; readonly detail?: string }[];
}

declare const linearIrCoverageTransactionBrand: unique symbol;
export interface LinearIrCoverageGenerationTransaction {
  readonly [linearIrCoverageTransactionBrand]: true;
}

interface TransactionPayload {
  readonly populationToken: object;
  readonly ordinal: number;
  readonly generationKind: LinearIrCoverageGenerationKind;
  readonly entrySourceId: IrSourceId;
  readonly entrySourceKey: string;
  readonly sources: readonly LinearIrCoverageSourceDescriptor[];
  readonly owners: readonly LinearIrCoverageOwnerDescriptor[];
  state: "fresh" | "finalized";
}

const transactions = new WeakMap<object, TransactionPayload>();
let activeTransaction: object | undefined;
let generationOrdinal = 0;
let lastCensus: LinearIrCoverageCensusV1 | undefined;

const SOURCE_KINDS = new Set<IrSourceKind>(["entry", "source", "library", "synthetic"]);
const OBSERVED_KINDS = new Set<IrTerminalObservedKind>(["function", "class-member"]);
const FUNCTION_TERMINAL_KINDS = new Set<IrUnitKind>(["top-level-function", "synthetic-support"]);
const CLASS_MEMBER_TERMINAL_KINDS = new Set<IrUnitKind>([
  "class-constructor",
  "class-implicit-constructor",
  "class-instance-method",
  "class-static-method",
  "class-instance-getter",
  "class-static-getter",
  "class-instance-setter",
  "class-static-setter",
]);
const UNIT_KINDS = new Set<IrUnitKind>([
  "top-level-function",
  "nested-function",
  "function-expression",
  "arrow-function",
  "class-constructor",
  "class-implicit-constructor",
  "class-instance-method",
  "class-static-method",
  "class-instance-getter",
  "class-static-getter",
  "class-instance-setter",
  "class-static-setter",
  "class-instance-field-initializer",
  "class-static-field-initializer",
  "class-static-block",
  "object-method",
  "object-getter",
  "object-setter",
  "export-assignment",
  "module-init",
  "synthetic-support",
]);
const NOT_ATTEMPTED_REASONS = new Set<LinearIrCoverageNotAttemptedReason>([
  "selector-omitted",
  "overlay-disabled",
  "generation-aborted",
  "multi-source-overlay-unimplemented",
]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: schema validation rejects non-layout C0 controls.
const NON_LAYOUT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: failure sanitization replaces every non-layout C0 control.
const NON_LAYOUT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export function compareLinearIrCoverageText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function coverageInvariant(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", `linear-ir coverage: ${detail}`);
}

function ownerInvariant(code: IrPlanningIdentityInvariantCode, detail: string): never {
  throw new IrPlanningIdentityInvariantError(code, detail);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort(compareLinearIrCoverageText);
  const canonicalExpected = [...expected].sort(compareLinearIrCoverageText);
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    coverageInvariant(`${label} fields are not exact`);
  }
}

function nonEmptyString(value: unknown, label: string, max = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    NON_LAYOUT_CONTROL_CHARACTER.test(value)
  ) {
    return coverageInvariant(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function safeCount(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return coverageInvariant(`${label} must be a finite non-negative safe integer`);
  }
  return value as number;
}

function sourceId(value: unknown, label: string): IrSourceId {
  const id = nonEmptyString(value, label);
  if (!id.startsWith("ir-source:v1:")) return coverageInvariant(`${label} is not a canonical source ID`);
  return id as IrSourceId;
}

function ownerUnitId(value: unknown, label: string, source: IrSourceId, terminalKind: IrUnitKind): IrUnitId {
  const id = nonEmptyString(value, label);
  const directTail = id.startsWith(`ir-unit:v1:${encodeURIComponent(source)}:`)
    ? id.slice(`ir-unit:v1:${encodeURIComponent(source)}:`.length)
    : undefined;
  const directParts = directTail?.split(":");
  const direct =
    directParts?.length === 3 &&
    directParts[0]!.length > 0 &&
    directParts[1] === terminalKind &&
    /^\d{16}$/.test(directParts[2]!);
  const derived = /^ir-unit:v1:derived:[^:]+:[^:]+:\d{16}$/.test(id);
  if (!direct && !derived) return coverageInvariant(`${label} is not a canonical source or derived unit ID`);
  return id as IrUnitId;
}

function canonicalSourceKey(value: unknown, label: string): string {
  const key = nonEmptyString(value, label);
  const segments = key.split("/");
  if (
    /^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(key) ||
    key.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return coverageInvariant(`${label} is not a canonical program-relative source key`);
  }
  return key;
}

function terminalKind(value: unknown, observedKind: IrTerminalObservedKind, label: string): IrUnitKind {
  const kind = nonEmptyString(value, label) as IrUnitKind;
  if (!UNIT_KINDS.has(kind)) return coverageInvariant(`${label} is unknown`);
  const allowed = observedKind === "function" ? FUNCTION_TERMINAL_KINDS : CLASS_MEMBER_TERMINAL_KINDS;
  if (!allowed.has(kind)) return coverageInvariant(`${label} does not match the observed owner kind`);
  return kind;
}

function exactSourceIdentity(input: {
  readonly id: unknown;
  readonly key: unknown;
  readonly kind: unknown;
  readonly order: unknown;
  readonly label: string;
}): { readonly sourceId: IrSourceId; readonly sourceKey: string; readonly kind: IrSourceKind; readonly order: number } {
  const kind = nonEmptyString(input.kind, `${input.label}.kind`) as IrSourceKind;
  if (!SOURCE_KINDS.has(kind)) return coverageInvariant(`${input.label}.kind is unknown`);
  const sourceKey = canonicalSourceKey(input.key, `${input.label}.sourceKey`);
  const order = safeCount(input.order, `${input.label}.order`);
  const id = sourceId(input.id, `${input.label}.sourceId`);
  if (id !== createIrSourceId({ kind, order, sourceKey })) {
    return coverageInvariant(`${input.label}.sourceId does not match its canonical kind/order/key`);
  }
  return { sourceId: id, sourceKey, kind, order };
}

function stableDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const detail = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)(?:[^\s:;,)}\]]+[\\/]?)+/g, "<path>")
    .replace(NON_LAYOUT_CONTROL_CHARACTERS, " ")
    .slice(0, 512);
  return detail.length > 0 ? detail : undefined;
}

function freezeSource(source: LinearIrCoverageSourceDescriptor): LinearIrCoverageSourceDescriptor {
  return Object.freeze({ ...source });
}

function freezeOwner(owner: LinearIrCoverageOwnerDescriptor): LinearIrCoverageOwnerDescriptor {
  return Object.freeze({ ...owner });
}

function validateSourceDescriptor(
  value: LinearIrCoverageSourceDescriptor,
  label: string,
): LinearIrCoverageSourceDescriptor {
  if (!plainRecord(value)) return coverageInvariant(`${label} must be a plain record`);
  exactKeys(value, ["sourceFile", "sourceId", "sourceKey", "kind", "order", "originalFileName"], label);
  if (value.sourceFile === null || typeof value.sourceFile !== "object") {
    return coverageInvariant(`${label}.sourceFile must retain an exact compiler object`);
  }
  const identity = exactSourceIdentity({
    id: value.sourceId,
    key: value.sourceKey,
    kind: value.kind,
    order: value.order,
    label,
  });
  const originalFileName = nonEmptyString(value.originalFileName, `${label}.originalFileName`, 4_096);
  if (
    !ts.isSourceFile(value.sourceFile as ts.Node) ||
    (value.sourceFile as ts.SourceFile).fileName !== originalFileName
  ) {
    return coverageInvariant(`${label}.sourceFile does not join its exact caller-supplied logical filename`);
  }
  return freezeSource({
    sourceFile: value.sourceFile,
    ...identity,
    originalFileName,
  });
}

function validateOwnerDescriptor(
  value: LinearIrCoverageOwnerDescriptor,
  label: string,
): LinearIrCoverageOwnerDescriptor {
  if (!plainRecord(value)) return coverageInvariant(`${label} must be a plain record`);
  exactKeys(
    value,
    [
      "ownerUnitId",
      "sourceId",
      "sourceKey",
      "legacyName",
      "terminalKind",
      "observedKind",
      "declaration",
      "terminalRecord",
    ],
    label,
  );
  if (value.declaration === null || typeof value.declaration !== "object") {
    return coverageInvariant(`${label}.declaration must retain an exact compiler object`);
  }
  if (value.terminalRecord === null || typeof value.terminalRecord !== "object") {
    return coverageInvariant(`${label}.terminalRecord must retain an exact inventory object`);
  }
  const observedKind = nonEmptyString(value.observedKind, `${label}.observedKind`) as IrTerminalObservedKind;
  if (!OBSERVED_KINDS.has(observedKind)) return coverageInvariant(`${label}.observedKind is not attemptable`);
  const source = sourceId(value.sourceId, `${label}.sourceId`);
  const kind = terminalKind(value.terminalKind, observedKind, `${label}.terminalKind`);
  return freezeOwner({
    ownerUnitId: ownerUnitId(value.ownerUnitId, `${label}.ownerUnitId`, source, kind),
    sourceId: source,
    sourceKey: canonicalSourceKey(value.sourceKey, `${label}.sourceKey`),
    legacyName: nonEmptyString(value.legacyName, `${label}.legacyName`),
    terminalKind: kind,
    observedKind: observedKind as Extract<IrTerminalObservedKind, "function" | "class-member">,
    declaration: value.declaration,
    terminalRecord: value.terminalRecord,
  });
}

const preparedPopulations = new WeakSet<PreparedLinearIrCoveragePopulation>();

export function isLinearIrAttemptRoot(terminal: IrTerminalUnitRecord): boolean {
  return !(
    terminal.kind === "synthetic-support" &&
    terminal.syntheticRole === "compiler-unit:timer-shim:set-timeout" &&
    terminal.terminalOwnerId === terminal.id &&
    terminal.lexicalOwnerId === null
  );
}

/** Authenticate the complete structural attempt-root population for one source. */
export function indexLinearIrSourceOwners(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
): LinearIrSourceOwnerIndex {
  const id = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(id) !== sourceFile) {
    return ownerInvariant("source-record-mismatch", `linear IR source ${id} does not resolve to its SourceFile`);
  }
  const expected = identityContext.inventory.terminalUnits.filter(
    (terminal) =>
      terminal.sourceId === id &&
      (terminal.observedKind === "function" || terminal.observedKind === "class-member") &&
      isLinearIrAttemptRoot(terminal),
  );
  const liveNodes = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    liveNodes.add(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const owners = expected.map((terminal): LinearIrSourceOwner => {
    const declaration = identityContext.declarationByUnitId.get(terminal.id);
    if (
      identityContext.unitByUnitId.get(terminal.id) !== terminal ||
      identityContext.terminalByUnitId.get(terminal.id) !== terminal ||
      terminal.terminalOwnerId !== terminal.id ||
      !declaration ||
      !liveNodes.has(declaration) ||
      declaration.getSourceFile() !== sourceFile ||
      identityContext.unitIdByDeclaration.get(declaration) !== terminal.id
    ) {
      return ownerInvariant(
        "terminal-record-mismatch",
        `linear IR source owner ${terminal.id} does not round-trip through the authoritative population`,
      );
    }
    return Object.freeze({ ownerUnitId: terminal.id, legacyName: terminal.legacyMatchName, declaration });
  });
  return Object.freeze({ owners: Object.freeze(owners) });
}

/** Project the already-authenticated linear owner seam into one coverage population. */
export function prepareLinearIrCoveragePopulation(
  sourceFiles: readonly ts.SourceFile[],
  entrySource: ts.SourceFile,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): PreparedLinearIrCoveragePopulation {
  const inventory = identityContext.inventory;
  if (
    sourceFiles.length === 0 ||
    inventory.sources.length !== sourceFiles.length ||
    !sourceFiles.includes(entrySource) ||
    new Set(sourceFiles).size !== sourceFiles.length ||
    identityContext.sourceIdBySourceFile.size !== sourceFiles.length ||
    identityContext.sourceFileBySourceId.size !== sourceFiles.length
  ) {
    return coverageInvariant("coverage source population is empty, duplicate, or incomplete");
  }
  const requestedFiles = new Set(sourceFiles);
  const sourceById = new Map(inventory.sources.map((source) => [source.id, source] as const));
  const fileById = new Map<IrSourceId, ts.SourceFile>();
  for (const sourceFile of sourceFiles) {
    const id = requireIrPlanningSourceId(identityContext, sourceFile);
    const record = sourceById.get(id);
    if (
      !record ||
      record.originalFileName !== sourceFile.fileName ||
      identityContext.sourceFileBySourceId.get(id) !== sourceFile ||
      identityContext.sourceIdBySourceFile.get(sourceFile) !== id ||
      fileById.has(id)
    ) {
      return coverageInvariant(`source ${sourceFile.fileName} does not round-trip through its inventory`);
    }
    fileById.set(id, sourceFile);
  }
  const sources = inventory.sources.map((source): LinearIrCoverageSourceDescriptor => {
    const sourceFile = fileById.get(source.id);
    if (!sourceFile || !requestedFiles.has(sourceFile)) {
      return coverageInvariant(`inventory source ${source.id} has no exact requested SourceFile`);
    }
    return Object.freeze({
      sourceFile,
      sourceId: source.id,
      sourceKey: source.sourceKey,
      kind: source.kind,
      order: source.order,
      originalFileName: source.originalFileName,
    });
  });
  const entryId = requireIrPlanningSourceId(identityContext, entrySource);
  if (sourceById.get(entryId)?.kind !== "entry") {
    return coverageInvariant("coverage entry is not the exact inventory entry row");
  }

  const owners: LinearIrCoverageOwnerDescriptor[] = [];
  const ownerIds = new Set<IrUnitId>();
  const declarations = new Set<ts.Node>();
  for (const sourceFile of sourceFiles) {
    const id = requireIrPlanningSourceId(identityContext, sourceFile);
    const source = sourceById.get(id)!;
    for (const owner of indexLinearIrSourceOwners(sourceFile, identityContext).owners) {
      const terminal = identityContext.terminalByUnitId.get(owner.ownerUnitId);
      const terminalRows = inventory.terminalUnits.filter((row) => row.id === owner.ownerUnitId);
      const unitRows = inventory.allUnits.filter((row) => row.id === owner.ownerUnitId);
      if (
        !terminal ||
        terminalRows.length !== 1 ||
        terminalRows[0] !== terminal ||
        unitRows.length !== 1 ||
        unitRows[0] !== terminal ||
        identityContext.unitByUnitId.get(owner.ownerUnitId) !== terminal ||
        terminal.sourceId !== id ||
        terminal.terminalOwnerId !== owner.ownerUnitId ||
        terminal.legacyMatchName !== owner.legacyName ||
        (terminal.observedKind !== "function" && terminal.observedKind !== "class-member") ||
        identityContext.declarationByUnitId.get(owner.ownerUnitId) !== owner.declaration ||
        identityContext.unitIdByDeclaration.get(owner.declaration) !== owner.ownerUnitId ||
        owner.declaration.getSourceFile() !== sourceFile ||
        ownerIds.has(owner.ownerUnitId) ||
        declarations.has(owner.declaration)
      ) {
        return coverageInvariant(`owner ${owner.ownerUnitId} lost its source/terminal/declaration join`);
      }
      ownerIds.add(owner.ownerUnitId);
      declarations.add(owner.declaration);
      owners.push(
        Object.freeze({
          ownerUnitId: owner.ownerUnitId,
          sourceId: id,
          sourceKey: source.sourceKey,
          legacyName: owner.legacyName,
          terminalKind: terminal.kind,
          observedKind: terminal.observedKind,
          declaration: owner.declaration,
          terminalRecord: terminal as IrTerminalUnitRecord,
        }),
      );
    }
  }
  const population = Object.freeze({
    sourceFiles: Object.freeze([...sourceFiles]),
    entrySource,
    checker,
    identityContext,
    sources: Object.freeze(sources),
    owners: Object.freeze(owners),
  });
  preparedPopulations.add(population);
  return population;
}

export function authenticateLinearIrCoveragePopulation(
  population: PreparedLinearIrCoveragePopulation,
  sourceFiles: readonly ts.SourceFile[],
  entrySource: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  if (
    !preparedPopulations.has(population) ||
    population.entrySource !== entrySource ||
    population.checker !== checker ||
    population.sourceFiles.length !== sourceFiles.length ||
    population.sourceFiles.some((sourceFile, index) => sourceFile !== sourceFiles[index])
  ) {
    coverageInvariant("coverage population is foreign, stale, or belongs to another source/checker generation");
  }
}

/** Exact default-off browser-safe coverage predicate. */
export function linearIrCoverageEnabled(host: unknown = globalThis): boolean {
  if (host === null || (typeof host !== "object" && typeof host !== "function")) return false;
  const processLike = (host as { process?: unknown }).process;
  if (processLike === null || (typeof processLike !== "object" && typeof processLike !== "function")) return false;
  const env = (processLike as { env?: unknown }).env;
  if (env === null || typeof env !== "object") return false;
  return (env as { JS2WASM_LINEAR_IR_COVERAGE?: unknown }).JS2WASM_LINEAR_IR_COVERAGE === "1";
}

/** Clear the finalized census without rewinding the process-global ordinal. */
export function resetLastLinearIrCoverageCensus(): number {
  if (activeTransaction !== undefined) return coverageInvariant("cannot reset a live generation transaction");
  lastCensus = undefined;
  return generationOrdinal;
}

export function getLastLinearIrCoverageCensus(): LinearIrCoverageCensusV1 | undefined {
  return lastCensus;
}

export function linearIrCoverageGenerationIsActive(): boolean {
  return activeTransaction !== undefined;
}

export function beginLinearIrCoverageGeneration(
  input: BeginLinearIrCoverageGenerationInput,
): LinearIrCoverageGenerationTransaction {
  if (activeTransaction !== undefined) return coverageInvariant("overlapping generations are not supported");
  if (!plainRecord(input) || input.populationToken === null || typeof input.populationToken !== "object") {
    return coverageInvariant("generation input or population token is not authenticatable");
  }
  exactKeys(
    input,
    ["populationToken", "generationKind", "entrySourceId", "entrySourceKey", "sources", "owners"],
    "generation input",
  );
  if (input.generationKind !== "single-source" && input.generationKind !== "multi-source") {
    return coverageInvariant("generation kind is unknown");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0 || !Array.isArray(input.owners)) {
    return coverageInvariant("generation population is malformed or empty at the source boundary");
  }
  const sources = input.sources.map((source, index) => validateSourceDescriptor(source, `sources[${index}]`));
  sources.sort((left, right) => compareLinearIrCoverageText(left.sourceKey, right.sourceKey));
  const sourceIds = new Set<IrSourceId>();
  const sourceKeys = new Set<string>();
  const sourceFiles = new Set<object>();
  const sourceOrders = new Set<number>();
  for (const source of sources) {
    if (
      sourceIds.has(source.sourceId) ||
      sourceKeys.has(source.sourceKey) ||
      sourceFiles.has(source.sourceFile) ||
      sourceOrders.has(source.order)
    ) {
      return coverageInvariant("generation sources contain a duplicate ID, key, file, or order");
    }
    sourceIds.add(source.sourceId);
    sourceKeys.add(source.sourceKey);
    sourceFiles.add(source.sourceFile);
    sourceOrders.add(source.order);
  }
  if ([...sourceOrders].sort((left, right) => left - right).some((order, index) => order !== index)) {
    return coverageInvariant("generation source orders are not a complete zero-based population");
  }
  const entrySourceId = sourceId(input.entrySourceId, "entrySourceId");
  const entrySourceKey = canonicalSourceKey(input.entrySourceKey, "entrySourceKey");
  const entryRows = sources.filter(
    (source) => source.sourceId === entrySourceId && source.sourceKey === entrySourceKey && source.kind === "entry",
  );
  if (entryRows.length !== 1 || sources.filter((source) => source.kind === "entry").length !== 1) {
    return coverageInvariant("generation entry does not join one exact source row");
  }
  if (input.generationKind === "single-source" && sources.length !== 1) {
    return coverageInvariant("single-source generation retained more than one source");
  }
  const owners = input.owners.map((owner, index) => validateOwnerDescriptor(owner, `owners[${index}]`));
  owners.sort((left, right) => compareLinearIrCoverageText(left.ownerUnitId, right.ownerUnitId));
  const ownerIds = new Set<IrUnitId>();
  const declarations = new Set<object>();
  const terminalRecords = new Set<object>();
  const sourceById = new Map(sources.map((source) => [source.sourceId, source] as const));
  for (const owner of owners) {
    const source = sourceById.get(owner.sourceId);
    if (!source || source.sourceKey !== owner.sourceKey) {
      return coverageInvariant(`owner ${owner.ownerUnitId} does not join its exact source ID/key`);
    }
    const declaration = owner.declaration as ts.Node;
    const terminal = owner.terminalRecord as Partial<IrTerminalUnitRecord>;
    if (
      typeof declaration.getSourceFile !== "function" ||
      declaration.getSourceFile() !== source.sourceFile ||
      terminal.id !== owner.ownerUnitId ||
      terminal.sourceId !== owner.sourceId ||
      terminal.kind !== owner.terminalKind ||
      terminal.observedKind !== owner.observedKind ||
      terminal.terminal !== true ||
      terminal.terminalOwnerId !== owner.ownerUnitId ||
      terminal.legacyMatchName !== owner.legacyName
    ) {
      return coverageInvariant(`owner ${owner.ownerUnitId} lost its exact source/declaration/terminal record`);
    }
    if (
      ownerIds.has(owner.ownerUnitId) ||
      declarations.has(owner.declaration) ||
      terminalRecords.has(owner.terminalRecord)
    ) {
      return coverageInvariant("generation owners contain a duplicate UnitId, declaration, or terminal record");
    }
    ownerIds.add(owner.ownerUnitId);
    declarations.add(owner.declaration);
    terminalRecords.add(owner.terminalRecord);
  }
  const prepared = input.populationToken as PreparedLinearIrCoveragePopulation;
  const exactSources = new Set(prepared.sources);
  const exactOwners = new Set(prepared.owners);
  if (
    !preparedPopulations.has(prepared) ||
    input.sources.length !== prepared.sources.length ||
    input.owners.length !== prepared.owners.length ||
    input.sources.some((source) => !exactSources.has(source)) ||
    input.owners.some((owner) => !exactOwners.has(owner))
  ) {
    return coverageInvariant("generation population token or descriptors are not an exact prepared population");
  }
  if (generationOrdinal >= Number.MAX_SAFE_INTEGER) return coverageInvariant("generation ordinal exhausted");
  lastCensus = undefined;
  const ordinal = ++generationOrdinal;
  const transaction = Object.freeze({}) as LinearIrCoverageGenerationTransaction;
  transactions.set(transaction, {
    populationToken: input.populationToken,
    ordinal,
    generationKind: input.generationKind,
    entrySourceId,
    entrySourceKey,
    sources: Object.freeze(sources),
    owners: Object.freeze(owners),
    state: "fresh",
  });
  activeTransaction = transaction;
  return transaction;
}

export function beginPreparedLinearIrCoverageGeneration(
  population: PreparedLinearIrCoveragePopulation,
  generationKind: LinearIrCoverageGenerationKind,
): LinearIrCoverageGenerationTransaction {
  authenticateLinearIrCoveragePopulation(
    population,
    population.sourceFiles,
    population.entrySource,
    population.checker,
  );
  const entryId = requireIrPlanningSourceId(population.identityContext, population.entrySource);
  const entry = population.sources.find((source) => source.sourceId === entryId);
  if (!entry || entry.kind !== "entry") return coverageInvariant("prepared population lost its exact entry source");
  return beginLinearIrCoverageGeneration({
    populationToken: population,
    generationKind,
    entrySourceId: entry.sourceId,
    entrySourceKey: entry.sourceKey,
    sources: population.sources,
    owners: population.owners,
  });
}

function evidenceKey(value: { readonly func: string; readonly reason: string; readonly detail?: string }): string {
  return `${value.func}\u0000${value.reason}\u0000${value.detail ?? ""}`;
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(compareLinearIrCoverageText);
  const b = [...right].sort(compareLinearIrCoverageText);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function freezeOutcome(outcome: LinearIrCoverageOutcomeV1): LinearIrCoverageOutcomeV1 {
  return Object.freeze({ ...outcome });
}

function freezeCensus(input: {
  readonly payload: TransactionPayload;
  readonly status: LinearIrCoverageStatus;
  readonly outcomes: ReadonlyMap<IrUnitId, LinearIrCoverageOutcomeV1>;
  readonly unresolvedReason: LinearIrCoverageNotAttemptedReason;
  readonly failure?: LinearIrCoverageFailureV1;
}): LinearIrCoverageCensusV1 {
  const { payload } = input;
  const sources = Object.freeze(
    payload.sources.map((source) =>
      Object.freeze({
        sourceId: source.sourceId,
        sourceKey: source.sourceKey,
        kind: source.kind,
        order: source.order,
      }),
    ),
  );
  const owners = Object.freeze(
    payload.owners.map((owner) =>
      Object.freeze({
        ownerUnitId: owner.ownerUnitId,
        sourceId: owner.sourceId,
        sourceKey: owner.sourceKey,
        legacyName: owner.legacyName,
        terminalKind: owner.terminalKind,
        observedKind: owner.observedKind,
        outcome: freezeOutcome(
          input.outcomes.get(owner.ownerUnitId) ?? {
            kind: "not-attempted",
            reason: input.unresolvedReason,
          },
        ),
      }),
    ),
  );
  let compiled = 0;
  let rejected = 0;
  let notAttempted = 0;
  for (const owner of owners) {
    if (owner.outcome.kind === "compiled") compiled++;
    else if (owner.outcome.kind === "rejected") rejected++;
    else notAttempted++;
  }
  const counts = Object.freeze({
    sources: sources.length,
    owners: owners.length,
    compiled,
    rejected,
    notAttempted,
  });
  return Object.freeze({
    schema: LINEAR_IR_COVERAGE_SCHEMA,
    generationOrdinal: payload.ordinal,
    generationKind: payload.generationKind,
    entrySourceId: payload.entrySourceId,
    entrySourceKey: payload.entrySourceKey,
    status: input.status,
    sources,
    owners,
    counts,
    ...(input.failure ? { failure: Object.freeze({ ...input.failure }) } : {}),
  });
}

export function finalizeLinearIrCoverageGeneration(
  transaction: LinearIrCoverageGenerationTransaction,
  input: FinalizeLinearIrCoverageGenerationInput,
): LinearIrCoverageCensusV1 {
  const payload = transactions.get(transaction);
  if (
    !payload ||
    payload.state !== "fresh" ||
    activeTransaction !== transaction ||
    !plainRecord(input) ||
    input.populationToken !== payload.populationToken
  ) {
    return coverageInvariant("generation transaction is foreign, stale, reused, or cross-population");
  }
  payload.state = "finalized";
  activeTransaction = undefined;
  const expectedKeys = [
    "populationToken",
    "status",
    "ownerEvidence",
    "publicCompiled",
    "publicRejected",
    "unresolvedReason",
    ...(input.failure === undefined ? [] : ["failure"]),
  ];
  exactKeys(input, expectedKeys, "finalization input");
  if (input.status !== "complete" && input.status !== "generation-failed") {
    return coverageInvariant("finalization status is unknown");
  }
  if (!NOT_ATTEMPTED_REASONS.has(input.unresolvedReason)) {
    return coverageInvariant("finalization unresolved reason is unknown");
  }
  const failure = input.failure === undefined ? undefined : validateLinearIrCoverageFailure(input.failure);
  if ((input.status === "generation-failed") !== (failure !== undefined)) {
    return coverageInvariant("generation failure status and failure evidence disagree");
  }
  if (
    !Array.isArray(input.ownerEvidence) ||
    !Array.isArray(input.publicCompiled) ||
    !Array.isArray(input.publicRejected)
  ) {
    return coverageInvariant("finalization evidence arrays are malformed");
  }
  const ownerById = new Map(payload.owners.map((owner) => [owner.ownerUnitId, owner] as const));
  const outcomes = new Map<IrUnitId, LinearIrCoverageOutcomeV1>();
  const compiledNames: string[] = [];
  const rejectedRows: string[] = [];
  for (const [index, evidence] of input.ownerEvidence.entries()) {
    if (!plainRecord(evidence)) return coverageInvariant(`ownerEvidence[${index}] must be a plain record`);
    const rawOwnerId = nonEmptyString(evidence.ownerUnitId, `ownerEvidence[${index}].ownerUnitId`) as IrUnitId;
    const ownerCandidate = ownerById.get(rawOwnerId);
    const ownerId = ownerCandidate
      ? ownerUnitId(
          rawOwnerId,
          `ownerEvidence[${index}].ownerUnitId`,
          ownerCandidate.sourceId,
          ownerCandidate.terminalKind,
        )
      : rawOwnerId;
    const owner = ownerById.get(ownerId);
    if (!owner || outcomes.has(ownerId) || evidence.legacyName !== owner.legacyName) {
      return coverageInvariant(`owner evidence ${ownerId} is unknown, duplicate, or label-drifted`);
    }
    if (evidence.outcome === "compiled") {
      exactKeys(evidence, ["outcome", "ownerUnitId", "legacyName"], `ownerEvidence[${index}]`);
      compiledNames.push(owner.legacyName);
      outcomes.set(ownerId, { kind: "compiled" });
      continue;
    }
    if (evidence.outcome !== "rejected" || !plainRecord(evidence.rejection)) {
      return coverageInvariant(`ownerEvidence[${index}] has an unknown outcome`);
    }
    exactKeys(evidence, ["outcome", "ownerUnitId", "legacyName", "rejection"], `ownerEvidence[${index}]`);
    const rawRejection = evidence.rejection;
    const rejectionHasDetail = Object.prototype.hasOwnProperty.call(rawRejection, "detail");
    exactKeys(
      rawRejection,
      ["func", "reason", ...(rejectionHasDetail ? ["detail"] : [])],
      `ownerEvidence[${index}].rejection`,
    );
    const func = nonEmptyString(rawRejection.func, `ownerEvidence[${index}].rejection.func`);
    const reason = nonEmptyString(rawRejection.reason, `ownerEvidence[${index}].rejection.reason`, 256);
    if (func !== owner.legacyName) return coverageInvariant(`rejection ${ownerId} lost its exact legacy label`);
    if (rawRejection.detail !== undefined && typeof rawRejection.detail !== "string") {
      return coverageInvariant(`ownerEvidence[${index}].rejection.detail must be a string`);
    }
    const rawDetail = rawRejection.detail;
    const detail = stableDetail(rawDetail);
    rejectedRows.push(evidenceKey({ func, reason, ...(rawDetail === undefined ? {} : { detail: rawDetail }) }));
    outcomes.set(ownerId, { kind: "rejected", reason, ...(detail === undefined ? {} : { detail }) });
  }
  for (const [index, value] of input.publicCompiled.entries()) {
    nonEmptyString(value, `publicCompiled[${index}]`);
  }
  const publicRejected = input.publicRejected.map((value, index) => {
    if (!plainRecord(value)) return coverageInvariant(`publicRejected[${index}] must be a plain record`);
    const rejectionHasDetail = Object.prototype.hasOwnProperty.call(value, "detail");
    exactKeys(value, ["func", "reason", ...(rejectionHasDetail ? ["detail"] : [])], `publicRejected[${index}]`);
    const func = nonEmptyString(value.func, `publicRejected[${index}].func`);
    const reason = nonEmptyString(value.reason, `publicRejected[${index}].reason`, 256);
    if (value.detail !== undefined && typeof value.detail !== "string") {
      return coverageInvariant(`publicRejected[${index}].detail must be a string`);
    }
    const detail = value.detail;
    return evidenceKey({ func, reason, ...(detail === undefined ? {} : { detail }) });
  });
  if (!sameStringMultiset(compiledNames, input.publicCompiled) || !sameStringMultiset(rejectedRows, publicRejected)) {
    return coverageInvariant("public compiled/rejected rows do not reconcile with structural owner evidence");
  }
  const census = freezeCensus({
    payload,
    status: input.status,
    outcomes,
    unresolvedReason: input.unresolvedReason,
    ...(failure ? { failure } : {}),
  });
  lastCensus = validateLinearIrCoverageCensus(census, { afterWatermark: payload.ordinal - 1 });
  return lastCensus;
}

export function finalizePreparedLinearIrCoverageGeneration(
  transaction: LinearIrCoverageGenerationTransaction,
  population: PreparedLinearIrCoveragePopulation,
  input: {
    readonly status: LinearIrCoverageStatus;
    readonly evidence?: LinearIrCoverageCompatibilityEvidence;
    readonly unresolvedReason: LinearIrCoverageNotAttemptedReason;
    readonly failure?: LinearIrCoverageFailureV1;
  },
): LinearIrCoverageCensusV1 {
  authenticateLinearIrCoveragePopulation(
    population,
    population.sourceFiles,
    population.entrySource,
    population.checker,
  );
  return finalizeLinearIrCoverageGeneration(transaction, {
    populationToken: population,
    status: input.status,
    ownerEvidence: input.evidence?.ownerEvidence ?? [],
    publicCompiled: input.evidence?.compiled ?? [],
    publicRejected: input.evidence?.rejected ?? [],
    unresolvedReason: input.unresolvedReason,
    ...(input.failure ? { failure: input.failure } : {}),
  });
}

/** Synchronous generation wrapper used only after the opt-in predicate succeeds. */
export function runPreparedLinearIrCoverageGeneration<T>(input: {
  readonly generationKind: LinearIrCoverageGenerationKind;
  readonly preparePopulation: () => PreparedLinearIrCoveragePopulation;
  readonly resetCompatibility: () => void;
  readonly readCompatibility: () => LinearIrCoverageCompatibilityEvidence | undefined;
  readonly unresolvedReason: LinearIrCoverageNotAttemptedReason;
  readonly failureUnresolvedReason: LinearIrCoverageNotAttemptedReason;
  readonly failurePhase: string;
  readonly generate: (population: PreparedLinearIrCoveragePopulation) => T;
}): T {
  input.resetCompatibility();
  resetLastLinearIrCoverageCensus();
  const population = input.preparePopulation();
  const transaction = beginPreparedLinearIrCoverageGeneration(population, input.generationKind);
  let generated = false;
  try {
    const value = input.generate(population);
    generated = true;
    finalizePreparedLinearIrCoverageGeneration(transaction, population, {
      status: "complete",
      evidence: input.readCompatibility(),
      unresolvedReason: input.unresolvedReason,
    });
    return value;
  } catch (error) {
    if (!generated) {
      try {
        finalizePreparedLinearIrCoverageGeneration(transaction, population, {
          status: "generation-failed",
          evidence: input.readCompatibility(),
          unresolvedReason: input.failureUnresolvedReason,
          failure: projectLinearIrCoverageFailure(input.failurePhase, error),
        });
      } catch {
        // Preserve the generator's original exception. The consumer observes
        // the missing census as a separate fail-closed instrumentation error.
      }
    }
    throw error;
  }
}

export function runSingleSourceLinearIrCoverageGeneration<T>(
  preparePopulation: () => PreparedLinearIrCoveragePopulation,
  resetCompatibility: () => void,
  readCompatibility: () => LinearIrCoverageCompatibilityEvidence | undefined,
  overlayEnabled: boolean,
  generate: (population: PreparedLinearIrCoveragePopulation) => T,
): T {
  return runPreparedLinearIrCoverageGeneration({
    generationKind: "single-source",
    preparePopulation,
    resetCompatibility,
    readCompatibility,
    unresolvedReason: overlayEnabled ? "selector-omitted" : "overlay-disabled",
    failureUnresolvedReason: "generation-aborted",
    failurePhase: "single-source-generation",
    generate,
  });
}

export function runMultiSourceLinearIrCoverageGeneration<T>(
  preparePopulation: () => PreparedLinearIrCoveragePopulation,
  resetCompatibility: () => void,
  generate: () => T,
): T {
  return runPreparedLinearIrCoverageGeneration({
    generationKind: "multi-source",
    preparePopulation,
    resetCompatibility,
    readCompatibility: () => undefined,
    unresolvedReason: "multi-source-overlay-unimplemented",
    failureUnresolvedReason: "multi-source-overlay-unimplemented",
    failurePhase: "multi-source-generation",
    generate,
  });
}

export function projectLinearIrCoverageFailure(phase: string, error: unknown): LinearIrCoverageFailureV1 {
  const errorRecord =
    error !== null && typeof error === "object" ? (error as { name?: unknown; message?: unknown }) : {};
  const detail = stableDetail(errorRecord.message ?? error) ?? "generation failed";
  const codeCandidate = typeof errorRecord.name === "string" ? errorRecord.name : "ThrownValue";
  const code = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(codeCandidate) ? codeCandidate : "ThrownValue";
  return Object.freeze({
    phase: nonEmptyString(phase, "failure phase", 128),
    code,
    detail,
  });
}

function validateLinearIrCoverageFailure(value: unknown): LinearIrCoverageFailureV1 {
  if (!plainRecord(value)) return coverageInvariant("failure must be a plain record");
  exactKeys(value, ["phase", "code", "detail"], "failure");
  const phase = nonEmptyString(value.phase, "failure.phase", 128);
  const code = nonEmptyString(value.code, "failure.code", 128);
  const detail = nonEmptyString(value.detail, "failure.detail", 512);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(code)) {
    return coverageInvariant("failure.code is not a stable bounded identifier");
  }
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|file:)/.test(detail) || /\/(?:private|tmp|Users|home)\//.test(detail)) {
    return coverageInvariant("failure.detail contains an absolute or temporary path");
  }
  return Object.freeze({ phase, code, detail });
}

function validateCensusSource(value: unknown, index: number): LinearIrCoverageSourceV1 {
  if (!plainRecord(value)) return coverageInvariant(`census.sources[${index}] must be a plain record`);
  exactKeys(value, ["sourceId", "sourceKey", "kind", "order"], `census.sources[${index}]`);
  return Object.freeze(
    exactSourceIdentity({
      id: value.sourceId,
      key: value.sourceKey,
      kind: value.kind,
      order: value.order,
      label: `census.sources[${index}]`,
    }),
  );
}

function validateCensusOutcome(value: unknown, label: string): LinearIrCoverageOutcomeV1 {
  if (!plainRecord(value)) return coverageInvariant(`${label} must be a plain record`);
  if (value.kind === "compiled") {
    exactKeys(value, ["kind"], label);
    return Object.freeze({ kind: "compiled" });
  }
  if (value.kind === "rejected") {
    exactKeys(value, ["kind", "reason", ...(value.detail === undefined ? [] : ["detail"])], label);
    const reason = nonEmptyString(value.reason, `${label}.reason`, 256);
    const detail = value.detail === undefined ? undefined : nonEmptyString(value.detail, `${label}.detail`, 512);
    return Object.freeze({ kind: "rejected", reason, ...(detail === undefined ? {} : { detail }) });
  }
  if (value.kind === "not-attempted") {
    exactKeys(value, ["kind", "reason"], label);
    const reason = nonEmptyString(value.reason, `${label}.reason`) as LinearIrCoverageNotAttemptedReason;
    if (!NOT_ATTEMPTED_REASONS.has(reason)) return coverageInvariant(`${label}.reason is unknown`);
    return Object.freeze({ kind: "not-attempted", reason });
  }
  return coverageInvariant(`${label}.kind is unknown`);
}

function validateCensusOwner(value: unknown, index: number): LinearIrCoverageOwnerV1 {
  if (!plainRecord(value)) return coverageInvariant(`census.owners[${index}] must be a plain record`);
  exactKeys(
    value,
    ["ownerUnitId", "sourceId", "sourceKey", "legacyName", "terminalKind", "observedKind", "outcome"],
    `census.owners[${index}]`,
  );
  const observedKind = nonEmptyString(value.observedKind, `census.owners[${index}].observedKind`);
  if (!OBSERVED_KINDS.has(observedKind as IrTerminalObservedKind)) {
    return coverageInvariant(`census.owners[${index}].observedKind is not attemptable`);
  }
  const source = sourceId(value.sourceId, `census.owners[${index}].sourceId`);
  const kind = terminalKind(
    value.terminalKind,
    observedKind as IrTerminalObservedKind,
    `census.owners[${index}].terminalKind`,
  );
  return Object.freeze({
    ownerUnitId: ownerUnitId(value.ownerUnitId, `census.owners[${index}].ownerUnitId`, source, kind),
    sourceId: source,
    sourceKey: canonicalSourceKey(value.sourceKey, `census.owners[${index}].sourceKey`),
    legacyName: nonEmptyString(value.legacyName, `census.owners[${index}].legacyName`),
    terminalKind: kind,
    observedKind: observedKind as Extract<IrTerminalObservedKind, "function" | "class-member">,
    outcome: validateCensusOutcome(value.outcome, `census.owners[${index}].outcome`),
  });
}

export function validateLinearIrCoverageCensus(
  value: unknown,
  options: { readonly afterWatermark?: number } = {},
): LinearIrCoverageCensusV1 {
  if (!plainRecord(value)) return coverageInvariant("census must be a plain record");
  const status = value.status;
  const hasFailure = value.failure !== undefined;
  exactKeys(
    value,
    [
      "schema",
      "generationOrdinal",
      "generationKind",
      "entrySourceId",
      "entrySourceKey",
      "status",
      "sources",
      "owners",
      "counts",
      ...(hasFailure ? ["failure"] : []),
    ],
    "census",
  );
  if (value.schema !== LINEAR_IR_COVERAGE_SCHEMA) return coverageInvariant("census schema is unknown");
  const generationOrdinalValue = safeCount(value.generationOrdinal, "census.generationOrdinal", 1);
  if (options.afterWatermark !== undefined) {
    const watermark = safeCount(options.afterWatermark, "validation watermark");
    if (generationOrdinalValue !== watermark + 1) return coverageInvariant("census generation ordinal is stale");
  }
  if (value.generationKind !== "single-source" && value.generationKind !== "multi-source") {
    return coverageInvariant("census generation kind is unknown");
  }
  if (status !== "complete" && status !== "generation-failed") return coverageInvariant("census status is unknown");
  const failure = hasFailure ? validateLinearIrCoverageFailure(value.failure) : undefined;
  if ((status === "generation-failed") !== (failure !== undefined)) {
    return coverageInvariant("census failure evidence and status disagree");
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0 || !Array.isArray(value.owners)) {
    return coverageInvariant("census source or owner arrays are malformed");
  }
  const sources = value.sources.map(validateCensusSource);
  const owners = value.owners.map(validateCensusOwner);
  if (
    sources.some(
      (source, index) => index > 0 && compareLinearIrCoverageText(sources[index - 1]!.sourceKey, source.sourceKey) >= 0,
    ) ||
    owners.some(
      (owner, index) =>
        index > 0 && compareLinearIrCoverageText(owners[index - 1]!.ownerUnitId, owner.ownerUnitId) >= 0,
    )
  ) {
    return coverageInvariant("census rows are not in strict canonical order");
  }
  const sourceById = new Map<IrSourceId, LinearIrCoverageSourceV1>();
  const sourceKeys = new Set<string>();
  const orders = new Set<number>();
  for (const source of sources) {
    if (sourceById.has(source.sourceId) || sourceKeys.has(source.sourceKey) || orders.has(source.order)) {
      return coverageInvariant("census contains duplicate source ID, key, or order");
    }
    sourceById.set(source.sourceId, source);
    sourceKeys.add(source.sourceKey);
    orders.add(source.order);
  }
  if ([...orders].sort((left, right) => left - right).some((order, index) => order !== index)) {
    return coverageInvariant("census source order is incomplete");
  }
  const entrySourceIdValue = sourceId(value.entrySourceId, "census.entrySourceId");
  const entrySourceKeyValue = canonicalSourceKey(value.entrySourceKey, "census.entrySourceKey");
  const entryRows = sources.filter(
    (source) =>
      source.kind === "entry" && source.sourceId === entrySourceIdValue && source.sourceKey === entrySourceKeyValue,
  );
  if (entryRows.length !== 1 || sources.filter((source) => source.kind === "entry").length !== 1) {
    return coverageInvariant("census entry source join drifted");
  }
  if (value.generationKind === "single-source" && sources.length !== 1) {
    return coverageInvariant("single-source census contains multiple sources");
  }
  let compiled = 0;
  let rejected = 0;
  let notAttempted = 0;
  for (const owner of owners) {
    const source = sourceById.get(owner.sourceId);
    if (!source || source.sourceKey !== owner.sourceKey) return coverageInvariant("census owner source join drifted");
    if (owner.outcome.kind === "compiled") compiled++;
    else if (owner.outcome.kind === "rejected") rejected++;
    else notAttempted++;
  }
  if (!plainRecord(value.counts)) return coverageInvariant("census.counts must be a plain record");
  exactKeys(value.counts, ["sources", "owners", "compiled", "rejected", "notAttempted"], "census.counts");
  const counts = Object.freeze({
    sources: safeCount(value.counts.sources, "census.counts.sources"),
    owners: safeCount(value.counts.owners, "census.counts.owners"),
    compiled: safeCount(value.counts.compiled, "census.counts.compiled"),
    rejected: safeCount(value.counts.rejected, "census.counts.rejected"),
    notAttempted: safeCount(value.counts.notAttempted, "census.counts.notAttempted"),
  });
  if (
    counts.sources !== sources.length ||
    counts.owners !== owners.length ||
    counts.compiled !== compiled ||
    counts.rejected !== rejected ||
    counts.notAttempted !== notAttempted ||
    counts.owners !== counts.compiled + counts.rejected + counts.notAttempted
  ) {
    return coverageInvariant("census counts do not reconcile with the complete population");
  }
  return Object.freeze({
    schema: LINEAR_IR_COVERAGE_SCHEMA,
    generationOrdinal: generationOrdinalValue,
    generationKind: value.generationKind,
    entrySourceId: entrySourceIdValue,
    entrySourceKey: entrySourceKeyValue,
    status,
    sources: Object.freeze(sources),
    owners: Object.freeze(owners),
    counts,
    ...(failure ? { failure } : {}),
  });
}

export function linearIrCoverageDigestProjection(census: unknown): Omit<LinearIrCoverageCensusV1, "generationOrdinal"> {
  const validated = validateLinearIrCoverageCensus(census);
  return Object.freeze({
    schema: validated.schema,
    generationKind: validated.generationKind,
    entrySourceId: validated.entrySourceId,
    entrySourceKey: validated.entrySourceKey,
    status: validated.status,
    sources: validated.sources,
    owners: validated.owners,
    counts: validated.counts,
    ...(validated.failure ? { failure: validated.failure } : {}),
  });
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return coverageInvariant("canonical JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!plainRecord(value)) return coverageInvariant("canonical JSON contains an unsupported value");
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareLinearIrCoverageText)
      .map((key) => {
        const member = value[key];
        if (member === undefined) return coverageInvariant("canonical JSON contains undefined");
        return [key, canonicalJsonValue(member)];
      }),
  );
}

export function canonicalLinearIrCoverageJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}
