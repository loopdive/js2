// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irClassTypeRef, irSupportTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { StructTypeDef, TypeDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { requireIrClassShapeClassId } from "./ir-class-shapes.js";
import { canonicalProgramAbiTypeDef } from "./program-abi-signatures.js";
import type { ProgramAbiSession, ProgramAbiTypeCell } from "./program-abi-session.js";

const PROGRAM_ABI_TYPE_ROLE = Object.freeze({
  retainedModuleType: 0,
  classLayout: 0,
} as const);

interface ProgramAbiClassLayoutObservation {
  readonly classId: IrClassId;
  readonly displayName: string;
  readonly cell: ProgramAbiTypeCell;
}

function canonicalEntrySource(session: ProgramAbiSession): IrSourceId {
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `type ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

/**
 * Compilation-wide exact type/class-layout sidecar.
 *
 * Class collection observes allocator objects before DCE, while final planning
 * happens after compaction. This is important for class expressions: legacy
 * codegen may allocate the same exact declaration more than once under
 * compatibility names, but one structural class ID must select the final live
 * compatibility owner. Every superseded allocator type still receives its own
 * generic retained-type entry.
 */
export class ProgramAbiTypeRegistry {
  private readonly classes = new Map<IrClassId, ProgramAbiClassLayoutObservation[]>();
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
    readonly identityContext: IrPlanningIdentityContext,
  ) {
    session.assertModule(ctx.mod);
    if (identityContext.inventory !== session.inventory) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "Program ABI type registry and planning context do not share one inventory",
      );
    }
  }

  /** Capture one exact class layout allocation before DCE can replace it. */
  observeClass(
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    displayName: string,
    type: StructTypeDef,
  ): IrClassId {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot observe class layout ${displayName} after retained type planning`,
      );
    }
    const classId = requireIrClassShapeClassId(declaration, this.identityContext);
    const cell = this.session.typeCellFor(type) ?? this.session.createTypeCell(type);
    const observations = this.classes.get(classId) ?? [];
    const previous = observations.at(-1);
    if (previous?.cell !== cell || previous.displayName !== displayName) {
      observations.push(Object.freeze({ classId, displayName, cell }));
      this.classes.set(classId, observations);
    }
    return classId;
  }

  /** Resolve one exact source class to its current allocator-owned struct layout. */
  layoutForClass(classId: IrClassId): { readonly typeIdx: number; readonly type: StructTypeDef } | undefined {
    const canonical = this.classes
      .get(classId)
      ?.filter((observation) => {
        const current = observation.cell.current;
        return current?.kind === "struct" && this.ctx.mod.types.includes(current);
      })
      .at(-1);
    const type = canonical?.cell.current;
    if (!type || type.kind !== "struct") return undefined;
    const typeIdx = this.ctx.mod.types.indexOf(type);
    return typeIdx < 0 ? undefined : Object.freeze({ typeIdx, type });
  }

  /** Plan all source classes plus every retained allocator type after DCE. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    for (const classRecord of this.session.inventory.classes) {
      const observations = this.classes.get(classRecord.id) ?? [];
      const live = observations.filter((observation) => observation.cell.current !== null);
      const canonical = live.at(-1);
      if (canonical) {
        const current = canonical.cell.current;
        if (!current || current.kind !== "struct") {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `class ${classRecord.id} no longer owns a retained struct layout`,
          );
        }
        this.planClass(classRecord.id, canonical.displayName, current, canonical.cell);
      } else {
        this.planSlotlessClass(classRecord.id, classRecord.displayName);
      }
    }

    const entrySourceId = canonicalEntrySource(this.session);
    for (let finalIndex = 0; finalIndex < this.ctx.mod.types.length; finalIndex++) {
      const type = this.ctx.mod.types[finalIndex]!;
      const cell = this.session.typeCellFor(type) ?? this.session.createTypeCell(type);
      if (this.session.locatorBindingId(cell)) continue;
      this.planRetainedType(entrySourceId, finalIndex, type, cell);
    }
  }

  private planClass(classId: IrClassId, displayName: string, type: StructTypeDef, cell: ProgramAbiTypeCell): void {
    const ref = irClassTypeRef(classId, displayName);
    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forClass(classId, {
        domain: "class",
        roleOrdinal: PROGRAM_ABI_TYPE_ROLE.classLayout,
      }),
      structuralReferenceKey,
      displayName,
      slotPolicy: "required",
      slotSpace: "type",
      intent: {
        kind: "class",
        classId,
        layoutKey: canonicalProgramAbiTypeDef(type),
      },
    });
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
    this.attachTypeLocator(ref.binding.bindingId, cell);
  }

  private planSlotlessClass(classId: IrClassId, displayName: string): void {
    const ref = irClassTypeRef(classId, displayName);
    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forClass(classId, {
        domain: "class",
        roleOrdinal: PROGRAM_ABI_TYPE_ROLE.classLayout,
      }),
      structuralReferenceKey,
      displayName,
      slotPolicy: "none",
      intent: {
        kind: "class",
        classId,
        layoutKey: "unallocated",
      },
    });
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
  }

  private planRetainedType(
    entrySourceId: IrSourceId,
    finalIndex: number,
    type: TypeDef,
    cell: ProgramAbiTypeCell,
  ): void {
    const ref = irSupportTypeRef(entrySourceId, "retained-module-type", `type#${finalIndex}`, finalIndex);
    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "type",
        roleOrdinal: PROGRAM_ABI_TYPE_ROLE.retainedModuleType,
        derivedOrdinal: finalIndex,
      }),
      structuralReferenceKey,
      displayName: type.kind === "rec" ? `type#${finalIndex}` : (type.name ?? `type#${finalIndex}`),
      slotPolicy: "required",
      slotSpace: "type",
      intent: {
        kind: "type",
        shapeKey: canonicalProgramAbiTypeDef(type),
      },
    });
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
    this.attachTypeLocator(ref.binding.bindingId, cell);
  }

  private attachTypeLocator(bindingId: IrBindingId, cell: ProgramAbiTypeCell): void {
    if (!this.session.hasLocator(bindingId, cell)) {
      this.session.attachLocator(bindingId, { kind: "type-cell", cell });
    }
  }
}
