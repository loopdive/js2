// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { GlobalDef, Import, WasmExport, WasmFunction } from "../ir/types.js";
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import type { CodegenContext } from "./context/types.js";
import type {
  PreparedProgramAbiDescriptorLifecycle,
  PreparedProgramAbiDescriptorPart,
  PreparedProgramAbiProvisionalBinding,
} from "./program-abi-prepared-transaction.js";
import type { ProgramAbiDraft, ProgramAbiDraftOrder, ProgramAbiSession } from "./program-abi-session.js";

const PROGRAM_ABI_EXPORT_ROLE = 0;

type ValueExport = WasmExport & {
  readonly desc: { readonly kind: "func" | "global"; readonly index: number };
};

type ValueExportTarget = Import | WasmFunction | GlobalDef;

interface PreparedExportDenominatorRow {
  readonly row: WasmExport;
  readonly ordinal: number;
  readonly name: string;
  readonly descriptor: WasmExport["desc"];
  readonly kind: WasmExport["desc"]["kind"];
  readonly index: number;
  readonly value?: ValueExportTarget;
  readonly expectedIntent?: "callable" | "global";
}

interface PreparedExportAliasRow extends PreparedExportDenominatorRow {
  readonly value: ValueExportTarget;
  readonly expectedIntent: "callable" | "global";
  readonly entrySourceId: IrSourceId;
  readonly bindingId: IrBindingId;
  readonly structuralOrder: ProgramAbiDraftOrder;
}

interface PreparedExportAliasDescriptorPayload {
  readonly registry: ProgramAbiExportRegistry;
  readonly lifecycle: PreparedProgramAbiDescriptorLifecycle;
  readonly denominator: readonly PreparedExportDenominatorRow[];
  readonly selected: readonly PreparedExportAliasRow[];
  readonly planned: boolean;
}

/** Opaque registry-authenticated token for exact prepared value-export aliases. */
export interface PreparedExportAliasDescriptor {
  readonly kind: "prepared-export-alias-descriptor";
}

const preparedExportAliasDescriptors = new WeakMap<
  PreparedExportAliasDescriptor,
  PreparedExportAliasDescriptorPayload
>();

function exportError(message: string): ProgramAbiInvariantError {
  return new ProgramAbiInvariantError("invalid-export-target", message);
}

function assertExportDescriptorFresh(lifecycle: PreparedProgramAbiDescriptorLifecycle): void {
  if (lifecycle.state.get("state") !== "fresh" || lifecycle.state.has("scopeId")) {
    throw exportError("prepared export-alias descriptor was already claimed or consumed");
  }
}

function assertExportDescriptorClaimed(lifecycle: PreparedProgramAbiDescriptorLifecycle, scopeId: string): void {
  if (lifecycle.state.get("state") !== "claimed" || lifecycle.state.get("scopeId") !== scopeId) {
    throw exportError(`prepared export-alias descriptor is not claimed by scope ${scopeId}`);
  }
}

function canonicalEntrySource(session: ProgramAbiSession): IrSourceId {
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `export ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

function finalValueIndex(ctx: CodegenContext, exported: ValueExport): number {
  const { kind, index } = exported.desc;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new ProgramAbiInvariantError(
      "invalid-export-target",
      `export ${exported.name} references invalid ${kind} index ${index}`,
    );
  }
  if (kind === "global") return index;
  try {
    return absoluteFuncIndex(ctx.mod, index);
  } catch (error) {
    throw new ProgramAbiInvariantError(
      "invalid-export-target",
      `export ${exported.name} references unresolvable function handle ${index}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function valueExportTarget(
  ctx: CodegenContext,
  exported: ValueExport,
): { readonly value: Import | WasmFunction | GlobalDef; readonly expectedIntent: "callable" | "global" } {
  const { kind, index } = exported.desc;
  const finalIndex = finalValueIndex(ctx, exported);

  let importIndex = 0;
  for (const value of ctx.mod.imports) {
    if (value.desc.kind !== kind) continue;
    if (importIndex++ === finalIndex) {
      return { value, expectedIntent: kind === "func" ? "callable" : "global" };
    }
  }
  const localIndex = finalIndex - importIndex;
  const value = kind === "func" ? ctx.mod.functions[localIndex] : ctx.mod.globals[localIndex];
  if (!value) {
    const resolved = finalIndex === index ? "" : ` (resolved to final index ${finalIndex})`;
    throw new ProgramAbiInvariantError(
      "invalid-export-target",
      `export ${exported.name} references missing ${kind} index ${index}${resolved}`,
    );
  }
  return { value, expectedIntent: kind === "func" ? "callable" : "global" };
}

function exportDraft(row: PreparedExportAliasRow, targetId: IrBindingId): ProgramAbiDraft {
  return Object.freeze({
    id: row.bindingId,
    structuralOrder: row.structuralOrder,
    displayName: row.name,
    slotPolicy: "alias" as const,
    aliasOf: targetId,
    intent: Object.freeze({
      kind: "export" as const,
      externalName: row.name,
      targetId,
    }),
  });
}

/**
 * Final public value-export population owner.
 *
 * Function/global export indices are resolved to exact allocator objects only
 * after DCE and every final function/global slot has an ABI owner. Each public
 * spelling then becomes a non-allocating export alias of that structural
 * owner. Memory/table/tag exports remain backend layout concerns outside the
 * Program ABI's three value index spaces.
 */
export class ProgramAbiExportRegistry {
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  /** Describe only aliases whose exact exported allocator belongs to this component. */
  describePrepared(targets: ReadonlySet<object>): PreparedExportAliasDescriptor | undefined {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot describe prepared export aliases after retained export planning",
      );
    }
    if (targets.size === 0) return undefined;
    const denominator = this.describeDenominator();
    const entrySourceId = canonicalEntrySource(this.session);
    const selected = Object.freeze(
      denominator.flatMap((row): readonly PreparedExportAliasRow[] => {
        if (row.value === undefined || row.expectedIntent === undefined || !targets.has(row.value)) return [];
        return [
          Object.freeze({
            ...row,
            value: row.value,
            expectedIntent: row.expectedIntent,
            entrySourceId,
            bindingId: createIrBindingId({
              ownerId: entrySourceId,
              domain: "export",
              role: "module-value-export",
              ordinal: row.ordinal,
            }),
            structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
              domain: "export",
              roleOrdinal: PROGRAM_ABI_EXPORT_ROLE,
              derivedOrdinal: row.ordinal,
            }),
          }),
        ];
      }),
    );
    if (selected.length === 0) return undefined;
    const descriptor = Object.freeze({ kind: "prepared-export-alias-descriptor" as const });
    preparedExportAliasDescriptors.set(
      descriptor,
      Object.freeze({
        registry: this,
        lifecycle: Object.freeze({
          state: new Map<"state" | "scopeId", string>([["state", "fresh"]]),
        }),
        denominator,
        selected,
        planned: this.planned,
      }),
    );
    return descriptor;
  }

  assertPreparedDescriptorCurrent(descriptor: PreparedExportAliasDescriptor): void {
    const payload = this.requirePreparedDescriptor(descriptor);
    if (this.planned !== payload.planned || this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "prepared export-alias descriptor crossed retained export planning",
      );
    }
    const actual = this.describeDenominator();
    if (actual.length !== payload.denominator.length) {
      throw exportError("prepared export-alias descriptor crossed a changed module-export denominator");
    }
    payload.denominator.forEach((expected, index) => {
      const observed = actual[index]!;
      if (
        observed.row !== expected.row ||
        observed.ordinal !== expected.ordinal ||
        observed.name !== expected.name ||
        observed.descriptor !== expected.descriptor ||
        observed.kind !== expected.kind ||
        observed.index !== expected.index ||
        observed.value !== expected.value ||
        observed.expectedIntent !== expected.expectedIntent
      ) {
        throw exportError(`prepared module export ${expected.name} at ordinal ${expected.ordinal} is stale`);
      }
    });
    const entrySourceId = canonicalEntrySource(this.session);
    for (const expected of payload.selected) {
      const bindingId = createIrBindingId({
        ownerId: entrySourceId,
        domain: "export",
        role: "module-value-export",
        ordinal: expected.ordinal,
      });
      const order = this.session.structuralOrder.forSource(entrySourceId, {
        domain: "export",
        roleOrdinal: PROGRAM_ABI_EXPORT_ROLE,
        derivedOrdinal: expected.ordinal,
      });
      if (
        expected.entrySourceId !== entrySourceId ||
        expected.bindingId !== bindingId ||
        expected.structuralOrder.sourceId !== order.sourceId ||
        expected.structuralOrder.declarationOrdinal !== order.declarationOrdinal ||
        expected.structuralOrder.domainOrdinal !== order.domainOrdinal ||
        expected.structuralOrder.roleOrdinal !== order.roleOrdinal ||
        expected.structuralOrder.derivedOrdinal !== order.derivedOrdinal
      ) {
        throw exportError(`prepared module export ${expected.name} changed its projected ID or structural order`);
      }
    }
  }

  /**
   * Plan the already-declared public aliases of exact prepared ABI targets.
   *
   * Prepared components seal before final dead-layout planning, so aliases
   * that already point at their allocator objects must join that scope before
   * it closes. Other exports remain untouched until `planRetained()` owns the
   * final complete population.
   */
  planAliasesForTargets(targetIds: ReadonlySet<IrBindingId>): void {
    if (this.planned || targetIds.size === 0) return;
    const entrySourceId = canonicalEntrySource(this.session);
    for (let ordinal = 0; ordinal < this.ctx.mod.exports.length; ordinal++) {
      const exported = this.ctx.mod.exports[ordinal]!;
      if (exported.desc.kind !== "func" && exported.desc.kind !== "global") continue;
      const valueExport = exported as ValueExport;
      const { value } = valueExportTarget(this.ctx, valueExport);
      const targetId = this.session.locatorBindingId(value);
      if (targetId !== undefined && targetIds.has(targetId)) {
        this.planValueExport(entrySourceId, ordinal, valueExport);
      }
    }
  }

  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    const entrySourceId = canonicalEntrySource(this.session);
    const exportNames = new Map<string, number>();
    for (let ordinal = 0; ordinal < this.ctx.mod.exports.length; ordinal++) {
      const exported = this.ctx.mod.exports[ordinal]!;
      const previous = exportNames.get(exported.name);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "duplicate-export-name",
          `module exports at positions ${previous} and ${ordinal} share external name ${exported.name}`,
        );
      }
      exportNames.set(exported.name, ordinal);
      if (exported.desc.kind !== "func" && exported.desc.kind !== "global") continue;
      this.planValueExport(entrySourceId, ordinal, exported as ValueExport);
    }
  }

  private planValueExport(entrySourceId: IrSourceId, ordinal: number, exported: ValueExport): void {
    const { value, expectedIntent } = valueExportTarget(this.ctx, exported);
    const targetId = this.session.locatorBindingId(value);
    if (!targetId) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `export ${exported.name} has no Program ABI owner for its exact ${exported.desc.kind} target`,
      );
    }
    this.assertTargetIntent(targetId, expectedIntent, exported);
    const id = createIrBindingId({
      ownerId: entrySourceId,
      domain: "export",
      role: "module-value-export",
      ordinal,
    });
    this.session.ensurePlan({
      id,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "export",
        roleOrdinal: PROGRAM_ABI_EXPORT_ROLE,
        derivedOrdinal: ordinal,
      }),
      displayName: exported.name,
      slotPolicy: "alias",
      aliasOf: targetId,
      intent: {
        kind: "export",
        externalName: exported.name,
        targetId,
      },
    });
  }

  private describeDenominator(): readonly PreparedExportDenominatorRow[] {
    const names = new Map<string, number>();
    return Object.freeze(
      this.ctx.mod.exports.map((row, ordinal): PreparedExportDenominatorRow => {
        const previous = names.get(row.name);
        if (previous !== undefined) {
          throw new ProgramAbiInvariantError(
            "duplicate-export-name",
            `module exports at positions ${previous} and ${ordinal} share external name ${row.name}`,
          );
        }
        names.set(row.name, ordinal);
        const target =
          row.desc.kind === "func" || row.desc.kind === "global"
            ? valueExportTarget(this.ctx, row as ValueExport)
            : undefined;
        return Object.freeze({
          row,
          ordinal,
          name: row.name,
          descriptor: row.desc,
          kind: row.desc.kind,
          index: row.desc.index,
          ...(target ?? {}),
        });
      }),
    );
  }

  private requirePreparedDescriptor(descriptor: PreparedExportAliasDescriptor): PreparedExportAliasDescriptorPayload {
    const payload = preparedExportAliasDescriptors.get(descriptor);
    if (!payload || payload.registry !== this) {
      throw exportError("prepared export-alias descriptor is forged or belongs to another registry");
    }
    return payload;
  }

  private assertTargetIntent(targetId: IrBindingId, expected: "callable" | "global", exported: ValueExport): void {
    const target = this.session.getDraft(targetId);
    if (!target || target.intent.kind !== expected || target.slotPolicy !== "required") {
      throw new ProgramAbiInvariantError(
        "invalid-export-target",
        `export ${exported.name} resolves to ${target?.intent.kind ?? "missing"} binding ${targetId}, expected ${expected}`,
      );
    }
  }
}

/** Authenticate and claim one export descriptor before the session projects its overlay targets. */
export function prepareExportAliasDescriptorForScope(
  descriptor: PreparedExportAliasDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): PreparedProgramAbiDescriptorPart {
  const payload = preparedExportAliasDescriptors.get(descriptor);
  if (!payload || payload.registry.session !== session || scopeId.length === 0) {
    throw exportError("prepared export-alias descriptor targets a foreign session or empty scope");
  }
  assertExportDescriptorFresh(payload.lifecycle);
  payload.lifecycle.state.set("scopeId", scopeId);
  payload.lifecycle.state.set("state", "claimed");
  try {
    payload.registry.assertPreparedDescriptorCurrent(descriptor);
    return Object.freeze({
      kind: "export-aliases" as const,
      session,
      descriptor,
      lifecycle: payload.lifecycle,
      bindings: Object.freeze([]),
      requestedStructuralReferenceKeys: Object.freeze([]),
      closureStructuralReferenceKeys: Object.freeze([]),
      registryWrites: Object.freeze([]),
      projectBindings: (
        resolveTargetId: (allocator: object) => IrBindingId | undefined,
        getDraft: (id: IrBindingId) => ProgramAbiDraft | undefined,
      ): readonly PreparedProgramAbiProvisionalBinding[] =>
        Object.freeze(
          payload.selected.map((row) => {
            const targetId = resolveTargetId(row.value);
            const target = targetId === undefined ? undefined : getDraft(targetId);
            if (
              targetId === undefined ||
              !target ||
              target.slotPolicy !== "required" ||
              target.intent.kind !== row.expectedIntent
            ) {
              throw exportError(
                `prepared export ${row.name} has no exact required ${row.expectedIntent} allocator owner in its batch`,
              );
            }
            return Object.freeze({ draft: exportDraft(row, targetId) });
          }),
        ),
      assertBindingClosure: (
        bindingIds: ReadonlySet<IrBindingId>,
        resolveTargetId: (allocator: object) => IrBindingId | undefined,
      ): void => {
        const selectedRows = new Set(payload.selected.map(({ row }) => row));
        for (const row of payload.denominator) {
          if (row.value === undefined) continue;
          const targetId = resolveTargetId(row.value);
          const expected = targetId !== undefined && bindingIds.has(targetId);
          if (selectedRows.has(row.row) !== expected) {
            throw exportError(
              `prepared export ${row.name} does not exactly match the component-owned allocator closure`,
            );
          }
        }
      },
      assertCurrent: () => {
        assertExportDescriptorClaimed(payload.lifecycle, scopeId);
        payload.registry.assertPreparedDescriptorCurrent(descriptor);
      },
    });
  } catch (error) {
    payload.lifecycle.state.set("state", "consumed");
    throw error;
  }
}

/** Consume one exact export descriptor at seal/abort without publishing registry state. */
export function consumePreparedExportAliasDescriptor(
  descriptor: PreparedExportAliasDescriptor,
  session: ProgramAbiSession,
  scopeId: string,
): void {
  const payload = preparedExportAliasDescriptors.get(descriptor);
  if (!payload || payload.registry.session !== session) {
    throw exportError("prepared export-alias descriptor targets a foreign session");
  }
  assertExportDescriptorClaimed(payload.lifecycle, scopeId);
  payload.lifecycle.state.set("state", "consumed");
}
