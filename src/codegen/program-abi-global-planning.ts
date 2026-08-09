// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irRetainedImportGlobalRef, irSupportGlobalRef } from "../ir/abi-bindings.js";
import { ts } from "../ts-api.js";
import type { IrSourceId } from "../ir/identity.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { GlobalDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalProgramAbiValType } from "./program-abi-signatures.js";
import type { ProgramAbiSession, ProgramAbiSlotLocator } from "./program-abi-session.js";

const PROGRAM_ABI_GLOBAL_ROLE = Object.freeze({
  nativeStringLiteral: 4,
  retained: 5,
} as const);
const RETAINED_MODULE_GLOBAL_ROLE = "retained-module-global";
type ProgramAbiGlobalLocator = Extract<ProgramAbiSlotLocator, { readonly kind: "defined-global" | "import-global" }>;

export interface ProgramAbiModuleBindingObservation {
  readonly displayName: string;
  readonly value: GlobalDef;
  readonly tdz?: GlobalDef;
}

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
  private readonly moduleBindings = new Map<ts.VariableDeclaration, ProgramAbiModuleBindingObservation>();
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  /** Observe one exact module declaration's allocator-owned value global. */
  observeModuleValue(declaration: ts.VariableDeclaration, displayName: string, value: GlobalDef): void {
    this.observeModuleBinding(declaration, displayName, value, "value");
  }

  /** Observe one exact module declaration's allocator-owned TDZ state global. */
  observeModuleTdz(declaration: ts.VariableDeclaration, displayName: string, value: GlobalDef): void {
    this.observeModuleBinding(declaration, displayName, value, "tdz");
  }

  /**
   * True when this exact declaration already owns a value global.
   *
   * (#1282) A TDZ flag may only be attached to the declaration that owns the
   * VALUE global. `ctx.moduleGlobals` / `ctx.tdzLetConstNames` are keyed by BARE
   * NAME across every module, while the declaration is resolved per source
   * file, so in a multi-package graph two different modules can each declare
   * `minimatch` — the value global belongs to whichever was seen first, and the
   * TDZ would otherwise be observed against the other one. Callers use this to
   * skip that mismatched pairing instead of tripping the ordering invariant.
   * Deliberately a cheap map probe: the caller runs it per TDZ name per module,
   * so it must not do the `mod.globals.includes` scan `moduleBinding` performs.
   */
  hasModuleValue(declaration: ts.VariableDeclaration): boolean {
    return this.moduleBindings.has(declaration);
  }

  /** Resolve one exact module declaration without consulting compatibility names. */
  moduleBinding(declaration: ts.VariableDeclaration): ProgramAbiModuleBindingObservation | undefined {
    const observation = this.moduleBindings.get(declaration);
    if (!observation || !this.ctx.mod.globals.includes(observation.value)) return undefined;
    if (observation.tdz && !this.ctx.mod.globals.includes(observation.tdz)) {
      return Object.freeze({
        displayName: observation.displayName,
        value: observation.value,
      });
    }
    return observation;
  }

  /**
   * Plan one immutable native-string literal global before a prepared IR
   * component seals. Its initializer owns the exact flat-string subtype/type
   * graph, while users depend only on this symbolic global and the common
   * string carrier.
   */
  prepareNativeStringLiteral(value: GlobalDef): IrGlobalRef {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot prepare native string literal ${value.name} after retained global planning`,
      );
    }
    const localOrdinal = this.ctx.mod.globals.indexOf(value);
    if (localOrdinal < 0 || value.mutable || !value.name.startsWith("__strlit_")) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        "native string literal preparation requires one immutable allocator-owned __strlit_ global",
      );
    }
    const entrySourceId = this.canonicalEntrySource();
    const ref = irSupportGlobalRef(entrySourceId, "native-string-literal", value.name, localOrdinal);
    this.planGlobal(
      entrySourceId,
      ref,
      localOrdinal,
      value.type,
      value.mutable,
      { kind: "defined-global", value },
      PROGRAM_ABI_GLOBAL_ROLE.nativeStringLiteral,
    );
    return ref;
  }

  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    const entrySourceId = this.canonicalEntrySource();
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
    roleOrdinal: number = PROGRAM_ABI_GLOBAL_ROLE.retained,
  ): void {
    const structuralReferenceKey = irGlobalBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "global",
        roleOrdinal,
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
    if (!this.session.hasLocator(ref.binding.bindingId, locator.value)) {
      this.session.attachLocator(ref.binding.bindingId, locator);
    }
  }

  private canonicalEntrySource(): IrSourceId {
    const entrySources = this.session.inventory.sources.filter((source) => source.kind === "entry");
    if (entrySources.length !== 1) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `global ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
      );
    }
    return entrySources[0]!.id;
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

  private observeModuleBinding(
    declaration: ts.VariableDeclaration,
    displayName: string,
    value: GlobalDef,
    role: "value" | "tdz",
  ): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot observe module ${role} global ${displayName} after retained global planning`,
      );
    }
    const expectedName = role === "value" ? `__mod_${displayName}` : `__tdz_${displayName}`;
    if (!this.ctx.mod.globals.includes(value) || value.name !== expectedName) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `module ${role} global ${displayName} has no exact allocator object named ${expectedName}`,
      );
    }

    const existing = this.moduleBindings.get(declaration);
    if (
      existing &&
      (existing.displayName !== displayName ||
        (role === "value" ? existing.value !== value : existing.tdz !== undefined && existing.tdz !== value))
    ) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `module declaration ${displayName} was observed with contradictory ${role} global allocator objects`,
      );
    }
    if (existing) {
      if (role === "tdz" && existing.tdz === undefined) {
        this.moduleBindings.set(
          declaration,
          Object.freeze({
            displayName,
            value: existing.value,
            tdz: value,
          }),
        );
      }
      return;
    }

    if (role === "value") {
      this.moduleBindings.set(declaration, Object.freeze({ displayName, value }));
      return;
    }
    throw new ProgramAbiInvariantError(
      "missing-required-locator",
      `module TDZ global ${displayName} was observed before its value global`,
    );
  }
}
