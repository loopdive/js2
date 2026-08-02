// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId, type IrBindingId, type IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { GlobalDef, Import, WasmExport, WasmFunction } from "../ir/types.js";
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import type { CodegenContext } from "./context/types.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

const PROGRAM_ABI_EXPORT_ROLE = 0;

type ValueExport = WasmExport & {
  readonly desc: { readonly kind: "func" | "global"; readonly index: number };
};

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
