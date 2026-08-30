// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irUnitCallableBindingId } from "../ir/callable-bindings.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import { createIrBindingId } from "../ir/identity.js";
import type { IrProgramCallableBindingGraph, IrProgramCallableBindingRecord } from "../ir/program-callable-bindings.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncTypeDef, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
  PreparedProgramAbiProvisionalBinding,
} from "./program-abi-prepared-transaction.js";
import type { ProgramAbiDraft, ProgramAbiSession } from "./program-abi-session.js";
import {
  canonicalProgramAbiCallableTypeContract,
  cloneProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
  type ProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

/** Structural role ordinals owned by internal module import/export aliases. */
const MODULE_IMPORT_ALIAS_ROLE_ORDINAL = 20;
const MODULE_EXPORT_ALIAS_ROLE_ORDINAL = 21;

export interface ProgramAbiModuleCallableAliasPlan {
  /** Exact immutable graph record being materialized in the Program ABI. */
  readonly record: IrProgramCallableBindingRecord;
  /** Binding ID of the next exact alias/source target in the graph chain. */
  readonly aliasOf: IrBindingId;
  /** Allocator-owned callable signature of the canonical source unit. */
  readonly signature: FuncTypeDef;
}

/** Input used to derive one opaque descriptor from the frozen callable graph. */
export interface PreparedModuleCallableAliasDescriptorInput {
  readonly session: ProgramAbiSession;
  readonly graph?: IrProgramCallableBindingGraph;
  readonly records?: readonly IrProgramCallableBindingRecord[];
  readonly terminalUnitIds: readonly IrUnitId[];
  /** Optional explicit roots, useful to prepare a strict component subset. */
  readonly rootBindingIds?: readonly IrBindingId[];
}

export interface PreparedModuleCallableAliasBinding {
  readonly record: IrProgramCallableBindingRecord;
  readonly aliasOf: IrBindingId;
  readonly targetBindingId: IrBindingId;
  readonly targetUnitId: IrUnitId;
  readonly targetRootBindingId: IrBindingId;
  readonly structuralReferenceKey: string;
  readonly draft: ProgramAbiDraft;
  readonly callableTypeContract: ProgramAbiCallableTypeContract;
}

interface PreparedModuleCallableAliasDescriptorPayload {
  readonly session: ProgramAbiSession;
  readonly graph: IrProgramCallableBindingGraph | undefined;
  readonly records: readonly IrProgramCallableBindingRecord[];
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly roots: readonly IrProgramCallableBindingRecord[];
  readonly aliases: readonly PreparedModuleCallableAliasBinding[];
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
}

/** Opaque session-authenticated descriptor for internal callable aliases. */
export interface PreparedModuleCallableAliasDescriptor {
  readonly kind: "prepared-module-callable-alias-descriptor";
}

const preparedModuleCallableAliasDescriptors = new WeakMap<
  PreparedModuleCallableAliasDescriptor,
  PreparedModuleCallableAliasDescriptorPayload
>();

function aliasError(code: ConstructorParameters<typeof ProgramAbiInvariantError>[0], message: string): never {
  throw new ProgramAbiInvariantError(code, message);
}

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function aliasRole(record: IrProgramCallableBindingRecord): string {
  return record.kind === "import-alias" ? "module-import-callable" : "module-export-callable";
}

function aliasRoleOrdinal(record: IrProgramCallableBindingRecord): number {
  return record.kind === "import-alias" ? MODULE_IMPORT_ALIAS_ROLE_ORDINAL : MODULE_EXPORT_ALIAS_ROLE_ORDINAL;
}

/** Stable reference key for one exact graph edge; labels are not consulted. */
export function moduleCallableAliasStructuralReferenceKey(
  record: IrProgramCallableBindingRecord,
  aliasOf: IrBindingId,
): string {
  return JSON.stringify([
    "module-callable-alias",
    record.kind,
    record.sourceId,
    record.declarationOrdinal,
    record.bindingOrdinal,
    record.bindingId,
    aliasOf,
    record.canonicalBindingId,
    record.targetUnitId,
  ]);
}

function exactRecords(input: PreparedModuleCallableAliasDescriptorInput): readonly IrProgramCallableBindingRecord[] {
  const records = input.records ?? input.graph?.records;
  if (!records) aliasError("invalid-binding-reference", "module callable alias descriptor has no graph records");
  if (input.graph && input.graph.records !== records) {
    aliasError("context-session-mismatch", "module callable alias descriptor records are not the frozen graph records");
  }
  const seen = new Set<IrBindingId>();
  const orders = new Set<string>();
  for (const record of records) {
    if (seen.has(record.bindingId))
      aliasError("duplicate-session-draft", `callable graph repeats binding ${record.bindingId}`);
    seen.add(record.bindingId);
    if (
      record.sourceId.length === 0 ||
      record.localName.length === 0 ||
      !validOrdinal(record.declarationOrdinal) ||
      !validOrdinal(record.bindingOrdinal) ||
      record.targetUnitId.length === 0 ||
      record.canonicalBindingId !== irUnitCallableBindingId(record.targetUnitId)
    ) {
      aliasError("invalid-binding-reference", `callable graph record ${record.bindingId} has invalid identity fields`);
    }
    const order = `${record.sourceId}\u0000${record.declarationOrdinal}\u0000${record.kind}\u0000${record.bindingOrdinal}`;
    if (orders.has(order)) aliasError("duplicate-draft-order", `callable graph repeats structural order ${order}`);
    orders.add(order);
    if (record.kind === "source") {
      if (record.bindingId !== record.targetBindingId || record.bindingId !== record.canonicalBindingId) {
        aliasError("binding-reference-mismatch", `source callable ${record.bindingId} is not self-canonical`);
      }
    } else {
      const expected = createIrBindingId({
        ownerId: record.sourceId,
        domain: "callable",
        role: aliasRole(record),
        ordinal: record.bindingOrdinal,
      });
      if (record.bindingId !== expected) {
        aliasError(
          "invalid-binding-reference",
          `module callable alias ${record.bindingId} is not the canonical ${aliasRole(record)} identity`,
        );
      }
    }
  }
  return records;
}

function sourceOrder(session: ProgramAbiSession, sourceId: IrSourceId): number {
  const source = session.inventory.sources.find((candidate) => candidate.id === sourceId);
  if (!source) aliasError("unknown-draft-source", `module callable alias references unknown source ${sourceId}`);
  return source.order;
}

function compareRecords(
  session: ProgramAbiSession,
  left: IrProgramCallableBindingRecord,
  right: IrProgramCallableBindingRecord,
): number {
  return (
    sourceOrder(session, left.sourceId) - sourceOrder(session, right.sourceId) ||
    left.declarationOrdinal - right.declarationOrdinal ||
    left.kind.localeCompare(right.kind) ||
    left.bindingOrdinal - right.bindingOrdinal ||
    left.bindingId.localeCompare(right.bindingId)
  );
}

function rootRecordFor(
  recordsById: ReadonlyMap<IrBindingId, IrProgramCallableBindingRecord>,
  rootBindingId: IrBindingId,
  unitId: IrUnitId,
): IrProgramCallableBindingRecord {
  const root = recordsById.get(rootBindingId);
  if (!root || root.kind !== "source" || root.targetUnitId !== unitId || root.canonicalBindingId !== rootBindingId) {
    aliasError("invalid-callable-provenance", `callable root ${rootBindingId} does not join terminal ${unitId}`);
  }
  return root;
}

function currentRootContract(
  session: ProgramAbiSession,
  root: IrProgramCallableBindingRecord,
): ProgramAbiCallableTypeContract {
  const draft = session.getDraft(root.bindingId);
  if (
    !draft ||
    draft.intent.kind !== "callable" ||
    draft.intent.origin !== "source" ||
    draft.intent.unitId !== root.targetUnitId ||
    draft.slotPolicy !== "required" ||
    draft.slotSpace !== "function"
  ) {
    aliasError("missing-source-unit", `callable root ${root.bindingId} has no exact source ABI reservation`);
  }
  const locator = session.locatorObjectForBinding(root.bindingId);
  if (!locator || typeof locator !== "object" || !("typeIdx" in locator)) {
    aliasError("missing-required-locator", `callable root ${root.bindingId} has no exact allocator function`);
  }
  const func = locator as WasmFunction;
  if (!session.hasLocator(root.bindingId, func)) {
    aliasError("locator-remap-mismatch", `callable root ${root.bindingId} lost its allocator object`);
  }
  const signature = session.module.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    aliasError("type-remap-mismatch", `callable root ${root.bindingId} has no current function type`);
  }
  const current = session.currentCallableSignature(root.bindingId);
  const allocator = canonicalProgramAbiCallableTypeContract(signature);
  if (!current || !programAbiCallableSignaturesEqual(current, allocator)) {
    aliasError("alias-signature-mismatch", `callable root ${root.bindingId} disagrees with its current allocator type`);
  }
  return cloneProgramAbiCallableTypeContract(signature);
}

function makeAliasBinding(
  session: ProgramAbiSession,
  record: IrProgramCallableBindingRecord,
  aliasOf: IrBindingId,
  contract: ProgramAbiCallableTypeContract,
): PreparedModuleCallableAliasBinding {
  const structuralReferenceKey = moduleCallableAliasStructuralReferenceKey(record, aliasOf);
  const draft = Object.freeze({
    id: record.bindingId,
    structuralOrder: session.structuralOrder.forSource(record.sourceId, {
      domain: "callable",
      roleOrdinal: aliasRoleOrdinal(record),
      derivedOrdinal: record.bindingOrdinal,
    }),
    structuralReferenceKey,
    displayName: record.localName,
    slotPolicy: "alias" as const,
    aliasOf,
    intent: Object.freeze({
      kind: "callable" as const,
      origin: "module-alias" as const,
      sourceId: record.sourceId,
      aliasKind: record.kind,
      targetUnitId: record.targetUnitId,
      signature: canonicalProgramAbiCallableTypeContract(contract),
    }),
  }) as ProgramAbiDraft;
  return Object.freeze({
    record,
    aliasOf,
    targetBindingId: record.targetBindingId,
    targetUnitId: record.targetUnitId,
    targetRootBindingId: record.canonicalBindingId,
    structuralReferenceKey,
    draft,
    callableTypeContract: cloneProgramAbiCallableTypeContract(contract),
  });
}

function descriptorBindings(
  payload: PreparedModuleCallableAliasDescriptorPayload,
): readonly PreparedModuleCallableAliasBinding[] {
  const rootsByUnit = new Map(payload.roots.map((root) => [root.targetUnitId, root] as const));
  const recordsById = new Map(payload.records.map((record) => [record.bindingId, record] as const));
  const rootContracts = new Map(
    payload.roots.map((root) => [root.bindingId, currentRootContract(payload.session, root)] as const),
  );
  const aliasesById = new Map(
    payload.records
      .filter((record) => record.kind !== "source" && rootsByUnit.has(record.targetUnitId))
      .sort((left, right) => compareRecords(payload.session, left, right))
      .map((record) => [record.bindingId, record] as const),
  );
  const resolved = new Map<IrBindingId, PreparedModuleCallableAliasBinding>();
  const visiting = new Set<IrBindingId>();
  const resolve = (record: IrProgramCallableBindingRecord): PreparedModuleCallableAliasBinding | undefined => {
    const known = resolved.get(record.bindingId);
    if (known) return known;
    if (visiting.has(record.bindingId))
      aliasError("alias-cycle", `module callable alias cycle includes ${record.bindingId}`);
    visiting.add(record.bindingId);
    const target = recordsById.get(record.targetBindingId);
    if (!target)
      aliasError(
        "missing-alias-target",
        `module callable alias ${record.bindingId} targets missing ${record.targetBindingId}`,
      );
    if (target.targetUnitId !== record.targetUnitId || record.canonicalBindingId !== target.canonicalBindingId) {
      aliasError("alias-contract-mismatch", `module callable alias ${record.bindingId} changes canonical target`);
    }
    const contract = rootContracts.get(record.canonicalBindingId);
    if (!contract)
      aliasError(
        "invalid-callable-provenance",
        `module callable alias ${record.bindingId} has no selected source root`,
      );
    const targetBinding = target.kind === "source" ? undefined : resolve(target);
    const aliasOf = targetBinding?.record.bindingId ?? target.bindingId;
    if (aliasOf === record.bindingId)
      aliasError("alias-cycle", `module callable alias ${record.bindingId} targets itself`);
    const targetContract = targetBinding?.callableTypeContract ?? rootContracts.get(target.bindingId);
    if (
      !targetContract ||
      !programAbiCallableSignaturesEqual(
        canonicalProgramAbiCallableTypeContract(targetContract),
        canonicalProgramAbiCallableTypeContract(contract),
      )
    ) {
      aliasError(
        "alias-signature-mismatch",
        `module callable alias ${record.bindingId} disagrees with target ${aliasOf}`,
      );
    }
    const binding = makeAliasBinding(payload.session, record, aliasOf, contract);
    visiting.delete(record.bindingId);
    resolved.set(record.bindingId, binding);
    return binding;
  };
  for (const record of aliasesById.values()) resolve(record);
  // The graph's targetBindingId points from an import to its export (when one
  // exists), and from an export to the source root.  Preserve that exact
  // direction in the descriptor so a consumer can replay the chain without
  // depending on Map insertion order: source -> export -> import.
  const ordered: PreparedModuleCallableAliasBinding[] = [];
  const emitted = new Set<IrBindingId>();
  const emit = (binding: PreparedModuleCallableAliasBinding): void => {
    if (emitted.has(binding.record.bindingId)) return;
    emitted.add(binding.record.bindingId);
    const target = resolved.get(binding.aliasOf);
    if (target) emit(target);
    ordered.push(binding);
  };
  for (const binding of [...resolved.values()].sort((left, right) =>
    compareRecords(payload.session, left.record, right.record),
  )) {
    emit(binding);
  }
  return Object.freeze(ordered);
}

function assertPayloadCurrent(payload: PreparedModuleCallableAliasDescriptorPayload): void {
  const records = payload.graph?.records ?? payload.records;
  if (
    records !== payload.records ||
    records.length !== payload.records.length ||
    records.some((record, i) => record !== payload.records[i])
  ) {
    aliasError("binding-reference-mismatch", "prepared module callable alias descriptor crossed a changed graph");
  }
  const actual = descriptorBindings(payload);
  if (actual.length !== payload.aliases.length)
    aliasError("session-draft-mismatch", "prepared module callable alias population changed");
  payload.aliases.forEach((expected, index) => {
    const observed = actual[index]!;
    if (
      observed.record !== expected.record ||
      observed.aliasOf !== expected.aliasOf ||
      observed.targetUnitId !== expected.targetUnitId ||
      observed.targetRootBindingId !== expected.targetRootBindingId ||
      observed.structuralReferenceKey !== expected.structuralReferenceKey
    ) {
      aliasError("session-draft-mismatch", `prepared module callable alias ${expected.record.bindingId} is stale`);
    }
    if (payload.session.getDraft(expected.record.bindingId) !== undefined) {
      aliasError(
        "duplicate-session-draft",
        `module callable alias ${expected.record.bindingId} already owns a session draft`,
      );
    }
  });
}

function provisionalBindings(
  payload: PreparedModuleCallableAliasDescriptorPayload,
): readonly PreparedProgramAbiProvisionalBinding[] {
  const aliases = descriptorBindings(payload);
  return Object.freeze(
    aliases.map((alias) =>
      Object.freeze({
        draft: alias.draft,
        structuralReferenceKey: alias.structuralReferenceKey,
        callableTypeContract: cloneProgramAbiCallableTypeContract(alias.callableTypeContract),
      }),
    ),
  );
}

function assertClaimed(lifecycle: PreparedProgramAbiDescriptorLifecycle, scopeId: string): void {
  if (lifecycle.state.get("state") !== "claimed" || lifecycle.state.get("scopeId") !== scopeId) {
    aliasError("session-closed", `prepared module callable alias descriptor is not claimed by ${scopeId}`);
  }
}

/** Derive one opaque, target-first module alias descriptor. */
export function describePreparedModuleCallableAliases(
  input: PreparedModuleCallableAliasDescriptorInput,
): PreparedModuleCallableAliasDescriptor | undefined {
  const records = exactRecords(input);
  const terminalUnitIds = Object.freeze([...input.terminalUnitIds]);
  if (terminalUnitIds.length === 0 || new Set(terminalUnitIds).size !== terminalUnitIds.length) {
    aliasError("invalid-callable-provenance", "module callable alias descriptor requires unique terminal roots");
  }
  for (const unitId of terminalUnitIds) {
    const inventoryUnit = input.session.inventory.terminalUnits.find((unit) => unit.id === unitId);
    if (!inventoryUnit || inventoryUnit.kind !== "top-level-function") {
      aliasError(
        "invalid-callable-provenance",
        `module callable alias root ${unitId} is not a top-level function terminal`,
      );
    }
  }
  const recordsById = new Map(records.map((record) => [record.bindingId, record] as const));
  const explicitRoots = input.rootBindingIds;
  if (explicitRoots && explicitRoots.length !== terminalUnitIds.length) {
    aliasError("invalid-callable-provenance", "module callable alias roots do not match terminal denominator");
  }
  const roots = Object.freeze(
    terminalUnitIds.map((unitId, index) =>
      rootRecordFor(recordsById, explicitRoots?.[index] ?? irUnitCallableBindingId(unitId), unitId),
    ),
  );
  // Authenticate every canonical root before deriving any provisional alias.
  for (const root of roots) currentRootContract(input.session, root);
  const payload: PreparedModuleCallableAliasDescriptorPayload = {
    session: input.session,
    graph: input.graph,
    records,
    terminalUnitIds,
    roots,
    aliases: Object.freeze([]),
    lifecycle: Object.freeze({
      state: new Map<"state" | "scopeId", string>([["state", "fresh"]]),
    }),
  };
  const aliases = descriptorBindings(payload);
  if (aliases.length === 0) return undefined;
  const exactPayload = Object.freeze({ ...payload, aliases });
  const descriptor = Object.freeze({ kind: "prepared-module-callable-alias-descriptor" as const });
  preparedModuleCallableAliasDescriptors.set(descriptor, exactPayload);
  return descriptor;
}

/** Compatibility spelling used by component planners while the owner migrates. */
export const createPreparedModuleCallableAliasDescriptor = describePreparedModuleCallableAliases;
export const planPreparedModuleCallableAliases = describePreparedModuleCallableAliases;

export function assertPreparedModuleCallableAliasDescriptorCurrent(
  descriptor: PreparedModuleCallableAliasDescriptor,
): void {
  const payload = preparedModuleCallableAliasDescriptors.get(descriptor);
  if (!payload) aliasError("context-session-mismatch", "prepared module callable alias descriptor is forged");
  if (payload.lifecycle.state.get("state") === "consumed") {
    aliasError("session-closed", "prepared module callable alias descriptor was already consumed");
  }
  assertPayloadCurrent(payload);
}

/** Claim an opaque descriptor for one exact open scope without consuming it. */
export function prepareModuleCallableAliasDescriptorForScope(
  descriptor: PreparedModuleCallableAliasDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): PreparedProgramAbiDescriptorPart {
  const payload = preparedModuleCallableAliasDescriptors.get(descriptor);
  if (!payload || payload.session !== session || scopeId.length === 0) {
    aliasError("context-session-mismatch", "prepared module callable alias descriptor targets a foreign session");
  }
  if (payload.lifecycle.state.get("state") !== "fresh" || payload.lifecycle.state.has("scopeId")) {
    aliasError("session-closed", "prepared module callable alias descriptor was already claimed or consumed");
  }
  payload.lifecycle.state.set("scopeId", scopeId);
  payload.lifecycle.state.set("state", "claimed");
  try {
    assertPayloadCurrent(payload);
    const bindings = provisionalBindings(payload);
    return Object.freeze({
      kind: "module-callable-aliases" as const,
      session,
      descriptor,
      lifecycle: payload.lifecycle,
      bindings,
      requestedStructuralReferenceKeys: Object.freeze([]),
      closureStructuralReferenceKeys: Object.freeze([]),
      exclusiveBindingIds: Object.freeze(payload.aliases.map(({ record }) => record.bindingId)),
      registryWrites: Object.freeze([]),
      rebaseBindings: () => provisionalBindings(payload),
      assertBindingClosure: (bindingIds: ReadonlySet<IrBindingId>) => {
        for (const alias of payload.aliases) {
          if (!bindingIds.has(alias.record.bindingId)) {
            aliasError(
              "invalid-binding-reference",
              `prepared scope ${scopeId} omitted alias ${alias.record.bindingId}`,
            );
          }
        }
      },
      assertCurrent: () => {
        assertClaimed(payload.lifecycle, scopeId);
        assertPayloadCurrent(payload);
      },
    });
  } catch (error) {
    payload.lifecycle.state.set("state", "consumed");
    throw error;
  }
}

/** Consume a descriptor exactly once after abort or successful publication. */
export function consumePreparedModuleCallableAliasDescriptor(
  descriptor: PreparedModuleCallableAliasDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = preparedModuleCallableAliasDescriptors.get(descriptor);
  if (!payload || payload.session !== session)
    aliasError("context-session-mismatch", "prepared module callable alias descriptor is forged");
  assertClaimed(payload.lifecycle, scopeId);
  payload.lifecycle.state.set("state", "consumed");
}

/** Inspect descriptor contents only for authenticated tests/owner adapters. */
export function preparedModuleCallableAliasBindings(
  descriptor: PreparedModuleCallableAliasDescriptor,
): readonly PreparedModuleCallableAliasBinding[] {
  const payload = preparedModuleCallableAliasDescriptors.get(descriptor);
  if (!payload) aliasError("context-session-mismatch", "prepared module callable alias descriptor is forged");
  return payload.aliases;
}

/**
 * Legacy one-shot compatibility planner. New aggregate code must use the
 * opaque descriptor and a prepared scope; this function remains only for
 * direct callers that have not crossed the aggregate transaction boundary.
 */
export function planProgramAbiModuleCallableAlias(
  ctx: CodegenContext,
  plan: ProgramAbiModuleCallableAliasPlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  const { record, aliasOf } = plan;
  if (record.kind === "source") {
    aliasError("invalid-callable-provenance", "module callable alias planning requires an import/export alias record");
  }
  if (
    !validOrdinal(record.declarationOrdinal) ||
    !validOrdinal(record.bindingOrdinal) ||
    record.sourceId.length === 0 ||
    record.localName.length === 0 ||
    record.targetUnitId.length === 0 ||
    record.canonicalBindingId !== irUnitCallableBindingId(record.targetUnitId) ||
    aliasOf !== record.targetBindingId
  ) {
    aliasError("invalid-binding-reference", `module callable alias ${record.bindingId} has incomplete graph identity`);
  }
  const expectedBindingId = createIrBindingId({
    ownerId: record.sourceId,
    domain: "callable",
    role: aliasRole(record),
    ordinal: record.bindingOrdinal,
  });
  if (record.bindingId !== expectedBindingId)
    aliasError("invalid-binding-reference", `module callable alias ${record.bindingId} has the wrong identity`);
  if (!session.hasKnownUnit(record.targetUnitId))
    aliasError("unknown-inventory-unit", `module callable alias ${record.bindingId} targets unknown unit`);
  if (aliasOf === record.bindingId)
    aliasError("alias-cycle", `module callable alias ${record.bindingId} targets itself`);
  const target = session.getDraft(aliasOf);
  if (!target || target.intent.kind !== "callable")
    aliasError(
      "missing-alias-target",
      `module callable alias ${record.bindingId} targets unplanned callable ${aliasOf}`,
    );
  if (
    (target.intent.origin === "source" && target.intent.unitId !== record.targetUnitId) ||
    (target.intent.origin === "module-alias" && target.intent.targetUnitId !== record.targetUnitId) ||
    target.intent.origin === "support" ||
    target.intent.origin === "import" ||
    target.intent.origin === "runtime" ||
    target.intent.origin === "intrinsic"
  )
    aliasError(
      "invalid-callable-provenance",
      `module callable alias ${record.bindingId} does not target its source unit`,
    );
  const contract = cloneProgramAbiCallableTypeContract(plan.signature);
  if (!programAbiCallableSignaturesEqual(target.intent.signature, canonicalProgramAbiCallableTypeContract(contract))) {
    aliasError(
      "alias-signature-mismatch",
      `module callable alias ${record.bindingId} disagrees with target ${aliasOf}`,
    );
  }
  const draft: ProgramAbiDraft = Object.freeze({
    id: record.bindingId,
    structuralOrder: session.structuralOrder.forSource(record.sourceId, {
      domain: "callable",
      roleOrdinal: aliasRoleOrdinal(record),
      derivedOrdinal: record.bindingOrdinal,
    }),
    structuralReferenceKey: moduleCallableAliasStructuralReferenceKey(record, aliasOf),
    displayName: record.localName,
    slotPolicy: "alias",
    aliasOf,
    intent: Object.freeze({
      kind: "callable" as const,
      origin: "module-alias" as const,
      sourceId: record.sourceId,
      aliasKind: record.kind,
      targetUnitId: record.targetUnitId,
      signature: canonicalProgramAbiCallableTypeContract(contract),
    }),
  });
  session.ensurePlan(draft);
  if (session.hasLocator(record.bindingId))
    aliasError("locator-not-required", `module callable alias ${record.bindingId} owns a locator`);
  session.registerCallableTypeContract(record.bindingId, contract);
  session.registerStructuralReference(record.bindingId, draft.structuralReferenceKey!);
  return record.bindingId;
}
