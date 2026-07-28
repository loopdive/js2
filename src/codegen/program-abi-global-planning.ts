// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irRetainedImportGlobalRef, irSupportGlobalRef } from "../ir/abi-bindings.js";
import type { IrSourceId } from "../ir/identity.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { GlobalDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalProgramAbiValType } from "./program-abi-signatures.js";
import type { ProgramAbiSession, ProgramAbiSlotLocator } from "./program-abi-session.js";

const PROGRAM_ABI_RETAINED_GLOBAL_ROLE = 5;
const RETAINED_MODULE_GLOBAL_ROLE = "retained-module-global";
type ProgramAbiGlobalLocator = Extract<ProgramAbiSlotLocator, { readonly kind: "defined-global" | "import-global" }>;

function displayName(name: string, finalIndex: number): string {
  return name.length > 0 ? name : `global#${finalIndex}`;
}

/**
 * Final global-space population owner.
 *
 * Exact source/runtime globals and string-constant imports may already have a
 * semantic Program ABI owner. This registry preserves those owners and
 * catalogs every remaining allocator object after all global allocation and
 * import shifts have settled. The result is a total one-to-one projection of
 * the final Wasm global index space without consulting moduleGlobals or names.
 */
export class ProgramAbiGlobalRegistry {
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    const entrySources = this.session.inventory.sources.filter((source) => source.kind === "entry");
    if (entrySources.length !== 1) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `global ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
      );
    }
    const entrySourceId = entrySources[0]!.id;
    const seen = new Set<object>();
    let finalIndex = 0;

    for (const value of this.ctx.mod.imports) {
      if (value.desc.kind !== "global") continue;
      this.assertUniqueAllocatorObject(seen, value, finalIndex);
      if (!this.session.locatorBindingId(value)) {
        const name = displayName(value.name, finalIndex);
        const ref = irRetainedImportGlobalRef(entrySourceId, value.module, value.name, name, finalIndex);
        this.planGlobal(entrySourceId, ref, finalIndex, value.desc.type, value.desc.mutable, {
          kind: "import-global",
          value,
        });
      }
      finalIndex++;
    }

    if (finalIndex !== this.ctx.numImportGlobals) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `global ABI planning found ${finalIndex} imported globals but the context records ${this.ctx.numImportGlobals}`,
      );
    }

    for (const value of this.ctx.mod.globals) {
      this.assertUniqueAllocatorObject(seen, value, finalIndex);
      if (!this.session.locatorBindingId(value)) {
        const name = displayName(value.name, finalIndex);
        const ref = irSupportGlobalRef(entrySourceId, RETAINED_MODULE_GLOBAL_ROLE, name, finalIndex);
        this.planGlobal(entrySourceId, ref, finalIndex, value.type, value.mutable, {
          kind: "defined-global",
          value,
        });
      }
      finalIndex++;
    }
  }

  private planGlobal(
    entrySourceId: IrSourceId,
    ref: IrGlobalRef,
    finalIndex: number,
    type: ValType,
    mutable: boolean,
    locator: ProgramAbiGlobalLocator,
  ): void {
    const structuralReferenceKey = irGlobalBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "global",
        roleOrdinal: PROGRAM_ABI_RETAINED_GLOBAL_ROLE,
        derivedOrdinal: finalIndex,
      }),
      structuralReferenceKey,
      displayName: ref.name,
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: ref.binding.kind === "import" ? "import" : "support",
        valueType: canonicalProgramAbiValType(type),
        mutable,
      },
    });
    this.session.registerGlobalTypeContract(ref.binding.bindingId, type, mutable);
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
    this.session.attachLocator(ref.binding.bindingId, locator);
  }

  private assertUniqueAllocatorObject(seen: Set<object>, value: Import | GlobalDef, finalIndex: number): void {
    if (seen.has(value)) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `global allocator object appears more than once in final global space at index ${finalIndex}`,
      );
    }
    seen.add(value);
  }
}
