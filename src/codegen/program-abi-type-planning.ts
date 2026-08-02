// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irClassTypeRef, irSupportTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId } from "../ir/identity.js";
import type { IrTypeRef, IrVecLayoutRef } from "../ir/nodes.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { StructTypeDef, TypeDef } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { requireIrClassShapeClassId } from "./ir-class-shapes.js";
import type { ProgramAbiSession, ProgramAbiTypeCell } from "./program-abi-session.js";
import { canonicalProgramAbiTypeDef, canonicalProgramAbiValType } from "./program-abi-signatures.js";

const PROGRAM_ABI_TYPE_ROLE = Object.freeze({
  retainedModuleType: 0,
  stringCarrier: 1,
  vectorCarrier: 2,
  vectorData: 3,
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

function vectorLogicalOrdinal(logicalKey: string): number {
  switch (logicalKey) {
    case "vec<f64>":
      return 0;
    case "vec<i32>":
      return 1;
    default:
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `vector layout ${logicalKey} has no stable Program ABI order`,
      );
  }
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
  private readonly vectorLayouts = new Map<
    string,
    {
      readonly carrierCell: ProgramAbiTypeCell;
      readonly dataCell: ProgramAbiTypeCell;
      readonly layout: IrVecLayoutRef;
    }
  >();
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

  /** Return the backend-neutral Program-ABI identity used by final string IR. */
  stringCarrierRef(): IrTypeRef {
    return irSupportTypeRef(canonicalEntrySource(this.session), "string-carrier", "__string_carrier");
  }

  /**
   * Plan the one backend-selected storage carrier behind `IrType.string`.
   *
   * Host strings use the built-in `externref` value type and therefore need
   * no module type slot. Native strings use the exact `$AnyString` allocator
   * object and a remappable type cell. Both backends expose the same symbolic
   * support identity to final IR; only this planner knows the physical shape.
   */
  prepareStringCarrier(): IrTypeRef {
    const entrySourceId = canonicalEntrySource(this.session);
    const ref = this.stringCarrierRef();
    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    const nativeType =
      this.ctx.nativeStrings && this.ctx.anyStrTypeIdx >= 0 ? this.ctx.mod.types[this.ctx.anyStrTypeIdx] : undefined;
    if (this.ctx.nativeStrings && this.ctx.anyStrTypeIdx >= 0 && !nativeType) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `native string carrier type ${this.ctx.anyStrTypeIdx} is absent from the allocator module`,
      );
    }
    const base = {
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "type",
        roleOrdinal: PROGRAM_ABI_TYPE_ROLE.stringCarrier,
      }),
      structuralReferenceKey,
      displayName: ref.name,
      intent: {
        kind: "type" as const,
        shapeKey: nativeType
          ? canonicalProgramAbiTypeDef(nativeType)
          : canonicalProgramAbiValType({ kind: "externref" }),
      },
    };
    this.session.ensurePlan(
      nativeType ? { ...base, slotPolicy: "required", slotSpace: "type" } : { ...base, slotPolicy: "none" },
    );
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
    if (nativeType) {
      const cell = this.session.typeCellFor(nativeType) ?? this.session.createTypeCell(nativeType);
      this.attachTypeLocator(ref.binding.bindingId, cell);
    }
    return ref;
  }

  /**
   * Plan the exact WasmGC carrier and backing-array types selected for one
   * logical dense-vector type.
   *
   * `logicalKey` is derived from backend-neutral IrType structure. Physical
   * indices are accepted only at this final allocator boundary and are
   * converted immediately into remappable Program-ABI type cells.
   */
  prepareVectorLayout(logicalKey: string, vecStructTypeIdx: number, arrayTypeIdx: number): IrVecLayoutRef {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot prepare vector layout ${logicalKey} after retained type planning`,
      );
    }
    if (logicalKey.length === 0) {
      throw new ProgramAbiInvariantError("unknown-order-anchor", "vector layout requires a logical type key");
    }
    const carrierType = this.ctx.mod.types[vecStructTypeIdx];
    const dataType = this.ctx.mod.types[arrayTypeIdx];
    if (!carrierType || carrierType.kind !== "struct" || !dataType || dataType.kind !== "array") {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `vector ${logicalKey} references invalid carrier/data types ${vecStructTypeIdx}/${arrayTypeIdx}`,
      );
    }
    const lengthField = carrierType.fields[0];
    const dataField = carrierType.fields[1];
    if (
      carrierType.fields.length !== 2 ||
      lengthField?.name !== "length" ||
      lengthField?.type.kind !== "i32" ||
      dataField?.name !== "data" ||
      (dataField?.type.kind !== "ref" && dataField?.type.kind !== "ref_null") ||
      dataField.type.typeIdx !== arrayTypeIdx
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `vector ${logicalKey} does not use the canonical { length, data } layout`,
      );
    }

    const carrierCell = this.session.typeCellFor(carrierType) ?? this.session.createTypeCell(carrierType);
    const dataCell = this.session.typeCellFor(dataType) ?? this.session.createTypeCell(dataType);
    const existing = this.vectorLayouts.get(logicalKey);
    if (existing) {
      if (existing.carrierCell !== carrierCell || existing.dataCell !== dataCell) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `logical vector ${logicalKey} was observed with two physical layouts`,
        );
      }
      return existing.layout;
    }

    const entrySourceId = canonicalEntrySource(this.session);
    const logicalOrdinal = vectorLogicalOrdinal(logicalKey);
    const carrierRef = irSupportTypeRef(
      entrySourceId,
      `vector-carrier:${logicalKey}`,
      `__ir_vec_carrier_${logicalKey}`,
    );
    const dataRef = irSupportTypeRef(entrySourceId, `vector-data:${logicalKey}`, `__ir_vec_data_${logicalKey}`);
    this.planPreparedSupportType(
      carrierRef,
      carrierType,
      carrierCell,
      PROGRAM_ABI_TYPE_ROLE.vectorCarrier,
      logicalOrdinal,
    );
    this.planPreparedSupportType(dataRef, dataType, dataCell, PROGRAM_ABI_TYPE_ROLE.vectorData, logicalOrdinal);
    const layout = Object.freeze({
      carrierType: carrierRef,
      dataType: dataRef,
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    });
    this.vectorLayouts.set(logicalKey, Object.freeze({ carrierCell, dataCell, layout }));
    return layout;
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

  private planPreparedSupportType(
    ref: IrTypeRef,
    type: TypeDef,
    cell: ProgramAbiTypeCell,
    roleOrdinal: number,
    derivedOrdinal: number,
  ): void {
    const entrySourceId = canonicalEntrySource(this.session);
    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    this.session.ensurePlan({
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "type",
        roleOrdinal,
        derivedOrdinal,
      }),
      structuralReferenceKey,
      displayName: ref.name,
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
