// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irClassTypeRef, irSupportTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import { irCallableBindingKey } from "../ir/callable-bindings.js";
import type { IrBindingId, IrClassId, IrSourceId } from "../ir/identity.js";
import type { IrClosureSignature, IrType, IrTypeRef, IrVecLayoutRef } from "../ir/nodes.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncTypeDef, StructTypeDef, TypeDef, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
// (#4241) The closure header layout is defined ONCE, in a leaf module both
// this validator and the mint sites can import — see closure-header-layout.ts.
import {
  closureSubtypeFieldCount,
  hasClosureHeaderPrefix,
  isCanonicalClosureHeader,
} from "./closures/closure-header-layout.js";
import { requireIrClassShapeClassId } from "./ir-class-shapes.js";
import type { ProgramAbiSession, ProgramAbiTypeCell } from "./program-abi-session.js";
import { canonicalProgramAbiTypeDef, canonicalProgramAbiValType } from "./program-abi-signatures.js";
import { DOM_CALLBACK_AUTHORITY_FIELD } from "../dom-capability-contract.js";

const PROGRAM_ABI_TYPE_ROLE = Object.freeze({
  retainedModuleType: 0,
  stringCarrier: 1,
  vectorCarrier: 2,
  vectorData: 3,
  closureWrapperRoot: 4,
  closureSignatureWrapper: 5,
  closureLiftedFunc: 6,
  closureCapturedSubtype: 7,
  dynamicCarrier: 8,
  exceptionTagType: 9,
  refCell: 10,
  objectLayout: 11,
  nativeMapCarrier: 12,
  classLayout: 0,
} as const);

export interface ProgramAbiDynamicCarrierSupport {
  readonly carrierRef: IrTypeRef;
  readonly valueType: string;
}

export type ProgramAbiClosureSupportRole = "carrier" | "invoke" | "allocate";

export interface ProgramAbiClosureSupportLayoutRequest {
  readonly signature: IrClosureSignature;
  readonly captureFieldTypes: readonly IrType[];
  /** Exact certified DOM callback identity when this is its private carrier. */
  readonly domCallbackAuthorityKey?: string;
  /** Strongest physical capability the final IR actually uses for this layout. */
  readonly role: ProgramAbiClosureSupportRole;
  /** Canonical module-wide wrapper root already allocated by the closure registry. */
  readonly wrapperRootType: StructTypeDef;
  /** Signature allocation wrapper; equal to wrapperRootType for the first signature. */
  readonly allocationWrapperType: StructTypeDef;
  /** Exact lifted-funcref type whose leading self parameter references the wrapper root. */
  readonly liftedFuncType: FuncTypeDef;
  /** Captured allocation subtype; equal to allocationWrapperType when there are no captures. */
  readonly capturedSubtypeType: StructTypeDef;
}

export interface ProgramAbiClosureSupportLayout {
  readonly semanticSignatureKey: string;
  readonly semanticLayoutKey: string;
  readonly wrapperRootRef: IrTypeRef;
  readonly allocationWrapperRef: IrTypeRef;
  readonly liftedFuncRef: IrTypeRef;
  readonly capturedSubtypeRef: IrTypeRef;
}

export interface ProgramAbiRefCellSupportRequest {
  readonly innerType: IrType;
  readonly cellType: StructTypeDef;
}

export interface ProgramAbiRefCellSupport {
  readonly semanticInnerTypeKey: string;
  readonly cellTypeRef: IrTypeRef;
}

export interface ProgramAbiObjectSupportRequest {
  readonly objectType: Extract<IrType, { readonly kind: "object" }>;
  readonly structType: StructTypeDef;
}

export interface ProgramAbiObjectSupport {
  readonly semanticShapeKey: string;
  readonly objectTypeRef: IrTypeRef;
}

interface ObservedRefCellSupport {
  readonly request: ProgramAbiRefCellSupportRequest;
  readonly support: ProgramAbiRefCellSupport;
}

interface ObservedClosureSupportLayout {
  readonly request: ProgramAbiClosureSupportLayoutRequest;
  readonly layout: ProgramAbiClosureSupportLayout;
}

interface CanonicalClosureSupportRequest {
  readonly request: ProgramAbiClosureSupportLayoutRequest;
  readonly signatureKey: string;
  readonly layoutKey: string;
}

function closureSupportRoleRank(role: ProgramAbiClosureSupportRole): number {
  switch (role) {
    case "carrier":
      return 0;
    case "invoke":
      return 1;
    case "allocate":
      return 2;
  }
}

function strongestClosureSupportRequest(
  left: CanonicalClosureSupportRequest,
  right: CanonicalClosureSupportRequest,
): CanonicalClosureSupportRequest {
  return closureSupportRoleRank(right.request.role) > closureSupportRoleRank(left.request.role) ? right : left;
}

function canonicalClosureSupportIrType(type: IrType, active: Set<object>): unknown {
  if (active.has(type)) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      "closure support semantic type contains a recursive anonymous IR layout",
    );
  }
  active.add(type);
  try {
    switch (type.kind) {
      case "val":
        if (type.val.kind === "ref" || type.val.kind === "ref_null") {
          throw new ProgramAbiInvariantError(
            "unknown-order-anchor",
            "closure support semantic types cannot contain module-relative ref type indices",
          );
        }
        return {
          kind: type.kind,
          value: canonicalProgramAbiValType(type.val),
          ...(type.val.kind === "i32" ? { signed: type.signed ?? true } : {}),
        };
      case "string":
        return { kind: type.kind };
      case "vec":
        return {
          kind: type.kind,
          elementType: canonicalClosureSupportIrType(type.elementType, active),
          nullable: type.nullable,
        };
      case "object":
        return {
          kind: type.kind,
          fields: type.shape.fields.map((field) => ({
            name: field.name,
            type: canonicalClosureSupportIrType(field.type, active),
          })),
        };
      case "closure":
      case "callable":
        return {
          kind: type.kind,
          signature: canonicalClosureSupportSignature(type.signature, active),
        };
      case "class":
        return { kind: type.kind, classId: type.shape.classId };
      case "extern":
        return { kind: type.kind, className: type.className };
      case "fnctor":
        return {
          kind: type.kind,
          sourceId: type.shape.sourceId,
          constructorUnitId: type.shape.constructorUnitId,
          constructorTarget: irCallableBindingKey(type.shape.constructorTarget.binding),
          reservedLayout: irTypeBindingKey(type.shape.reservedLayout.binding),
        };
      case "union":
        return {
          kind: type.kind,
          members: type.members.map((member) => canonicalClosureSupportIrType(member, active)),
        };
      case "boxed":
        return { kind: type.kind, inner: canonicalClosureSupportIrType(type.inner, active) };
      case "dynamic":
        return { kind: type.kind, tag: type.tag ?? null };
    }
  } finally {
    active.delete(type);
  }
}

function canonicalClosureSupportSignature(signature: IrClosureSignature, active = new Set<object>()): unknown {
  if (active.has(signature)) {
    throw new ProgramAbiInvariantError("unknown-order-anchor", "closure support contains a recursive IR signature");
  }
  active.add(signature);
  try {
    return {
      params: signature.params.map((type) => canonicalClosureSupportIrType(type, active)),
      returnType: signature.returnType === null ? null : canonicalClosureSupportIrType(signature.returnType, active),
    };
  } finally {
    active.delete(signature);
  }
}

/** Backend-neutral semantic key for one caller-visible closure signature. */
export function canonicalProgramAbiClosureSignatureKey(signature: IrClosureSignature): string {
  return JSON.stringify(canonicalClosureSupportSignature(signature));
}

/** Backend-neutral semantic key for one signature plus ordered capture layout. */
export function canonicalProgramAbiClosureLayoutKey(
  signature: IrClosureSignature,
  captureFieldTypes: readonly IrType[],
  domCallbackAuthorityKey?: string,
): string {
  const ordinary = {
    signature: canonicalClosureSupportSignature(signature),
    captures: captureFieldTypes.map((type) => canonicalClosureSupportIrType(type, new Set<object>())),
  };
  return JSON.stringify(
    domCallbackAuthorityKey === undefined ? ordinary : { ...ordinary, domCallbackAuthority: domCallbackAuthorityKey },
  );
}

/** Backend-neutral semantic key for one mutable-capture cell payload. */
export function canonicalProgramAbiRefCellKey(innerType: IrType): string {
  return JSON.stringify(canonicalClosureSupportIrType(innerType, new Set<object>()));
}

/** Backend-neutral semantic key for one closed IR object layout. */
export function canonicalProgramAbiObjectShapeKey(objectType: Extract<IrType, { readonly kind: "object" }>): string {
  return JSON.stringify(canonicalClosureSupportIrType(objectType, new Set<object>()));
}

interface ProgramAbiClassLayoutObservation {
  readonly classId: IrClassId;
  readonly displayName: string;
  readonly cell: ProgramAbiTypeCell;
}

/** True when every index-bearing edge can participate in Program-ABI remapping. */
export function isEarlyPreparableClassLayout(type: StructTypeDef): boolean {
  // `-1` is the module IR's explicit "no supertype" sentinel for hierarchy
  // roots; derived layouts carry a non-negative remappable index.
  if (type.superTypeIdx !== undefined && (!Number.isInteger(type.superTypeIdx) || type.superTypeIdx < -1)) return false;
  return type.fields.every((field) => {
    if (field.type.kind !== "ref" && field.type.kind !== "ref_null") return true;
    return Number.isInteger(field.type.typeIdx) && field.type.typeIdx >= 0;
  });
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
    case "vec<externref>":
      return 2;
    case "vec<string>":
      return 3;
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
  private readonly closureSupportLayouts = new Map<string, ObservedClosureSupportLayout>();
  private readonly refCellSupport = new Map<string, ObservedRefCellSupport>();
  private readonly objectSupport = new Map<
    string,
    { readonly request: ProgramAbiObjectSupportRequest; readonly support: ProgramAbiObjectSupport }
  >();
  private dynamicCarrierSupport?: {
    readonly support: ProgramAbiDynamicCarrierSupport;
    readonly type?: TypeDef;
    readonly cell?: ProgramAbiTypeCell;
  };
  private exceptionTagTypeRefValue?: IrTypeRef;
  private nativeMapCarrierSupport?: {
    readonly ref: IrTypeRef;
    readonly type: StructTypeDef;
    readonly cell: ProgramAbiTypeCell;
  };
  private closureSupportBatchPlanned = false;
  private refCellSupportBatchPlanned = false;
  private objectSupportBatchPlanned = false;
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

  /** Whether one collected class layout can be tracked through type-index compaction. */
  canPrepareClassLayout(classId: IrClassId): boolean {
    const layout = this.layoutForClass(classId);
    return layout !== undefined && isEarlyPreparableClassLayout(layout.type);
  }

  /** Publish one remappable class layout for an early prepared component. */
  prepareClassLayout(classId: IrClassId): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot prepare class layout ${classId} after retained type planning`,
      );
    }
    const classRecord = this.session.inventory.classes.find((record) => record.id === classId);
    const observations = this.classes.get(classId) ?? [];
    const canonical = observations.filter((observation) => observation.cell.current !== null).at(-1);
    const current = canonical?.cell.current;
    if (!classRecord || !canonical || !current || current.kind !== "struct" || !isEarlyPreparableClassLayout(current)) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `prepared class ${classId} has no retained remappable layout ` +
          `(inventory=${classRecord ? "present" : "missing"}, observations=${observations.length}, ` +
          `canonical=${canonical ? "present" : "missing"}, current=${current?.kind ?? "missing"}, ` +
          `preparable=${current?.kind === "struct" ? isEarlyPreparableClassLayout(current) : false})`,
      );
    }
    this.planClass(classId, canonical.displayName, current, canonical.cell);
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
   * Plan the backend-selected carrier behind an exact prepared `dynamic`
   * boundary. Slotless `externref` and the remappable `$AnyValue` layout use
   * one symbolic identity; callers never infer either representation from a
   * target flag or a raw type index.
   */
  prepareDynamicCarrier(carrier: ValType): ProgramAbiDynamicCarrierSupport {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot prepare the dynamic carrier after retained type planning",
      );
    }
    const entrySourceId = canonicalEntrySource(this.session);
    const ref = irSupportTypeRef(entrySourceId, "dynamic-carrier", "__ir_dynamic_carrier");
    const valueType = canonicalProgramAbiValType(carrier);
    const nativeType =
      carrier.kind === "ref" || carrier.kind === "ref_null" ? this.ctx.mod.types[carrier.typeIdx] : undefined;
    if ((carrier.kind === "ref" || carrier.kind === "ref_null") && !nativeType) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `dynamic carrier references absent allocator type ${carrier.typeIdx}`,
      );
    }
    if (!nativeType && carrier.kind !== "externref") {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `dynamic carrier ${valueType} is neither externref nor a remappable module type`,
      );
    }
    const cell = nativeType
      ? (this.session.typeCellFor(nativeType) ?? this.session.createTypeCell(nativeType))
      : undefined;
    const existing = this.dynamicCarrierSupport;
    if (existing) {
      if (existing.support.valueType !== valueType || existing.type !== nativeType || existing.cell !== cell) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          "one compilation selected more than one physical dynamic carrier",
        );
      }
      return existing.support;
    }

    const structuralReferenceKey = irTypeBindingKey(ref.binding);
    const base = {
      id: ref.binding.bindingId,
      structuralOrder: this.session.structuralOrder.forSource(entrySourceId, {
        domain: "type" as const,
        roleOrdinal: PROGRAM_ABI_TYPE_ROLE.dynamicCarrier,
      }),
      structuralReferenceKey,
      displayName: ref.name,
      intent: {
        kind: "type" as const,
        shapeKey: nativeType ? canonicalProgramAbiTypeDef(nativeType) : valueType,
      },
    };
    this.session.ensurePlan(
      nativeType ? { ...base, slotPolicy: "required", slotSpace: "type" } : { ...base, slotPolicy: "none" },
    );
    this.session.registerStructuralReference(ref.binding.bindingId, structuralReferenceKey);
    if (cell) this.attachTypeLocator(ref.binding.bindingId, cell);
    const support = Object.freeze({ carrierRef: ref, valueType });
    this.dynamicCarrierSupport = Object.freeze({ support, ...(nativeType ? { type: nativeType, cell: cell! } : {}) });
    return support;
  }

  /**
   * Plan the exact function type owned by the compilation's singleton
   * exception tag. Prepared IR normally rejects `throw` because the node has
   * no symbolic tag operand; the bounded TDZ writeback shape instead carries
   * this sidecar after proving that its throw is the canonical null-payload
   * TDZ guard. Tying the ref to the tag's allocator-owned type object keeps
   * that exception support inside Program-ABI type remapping.
   */
  prepareExceptionTagType(): IrTypeRef {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot prepare the exception-tag type after retained type planning",
      );
    }
    const existing = this.exceptionTagTypeRefValue;
    if (existing) return existing;
    const tag = this.ctx.exnTagIdx >= 0 ? this.ctx.mod.tags[this.ctx.exnTagIdx] : undefined;
    const type = tag ? this.ctx.mod.types[tag.typeIdx] : undefined;
    if (
      !tag ||
      type?.kind !== "func" ||
      type.params.length !== 1 ||
      type.params[0]?.kind !== "externref" ||
      type.results.length !== 0
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        "prepared exception support requires the exact singleton (externref) -> void tag type " +
          `(tag=${this.ctx.exnTagIdx}, type=${tag?.typeIdx ?? "missing"}, shape=${
            type ? canonicalProgramAbiTypeDef(type) : "missing"
          })`,
      );
    }
    const entrySourceId = canonicalEntrySource(this.session);
    const ref = irSupportTypeRef(entrySourceId, "exception-tag-type", "__ir_exception_tag_type");
    const cell = this.session.typeCellFor(type) ?? this.session.createTypeCell(type);
    this.planPreparedSupportType(ref, type, cell, PROGRAM_ABI_TYPE_ROLE.exceptionTagType, 0);
    this.exceptionTagTypeRefValue = ref;
    return ref;
  }

  /**
   * Plan the exact native `$Map` carrier used by host-free IR Map adapters.
   *
   * The middle end initially sees the allocator-owned `ref $Map` selected by
   * the compatibility resolver. Prepared components cannot seal against that
   * raw module-relative index, so the final preparation pass attaches this
   * remappable support identity to every retained Map value type.
   */
  prepareNativeMapCarrier(): IrTypeRef {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot prepare the native Map carrier after retained type planning",
      );
    }
    const typeIdx = this.ctx.mapTypeIdx;
    const type = typeIdx >= 0 ? this.ctx.mod.types[typeIdx] : undefined;
    if (
      !type ||
      type.kind !== "struct" ||
      type.name !== "Map" ||
      this.ctx.structMap.get("Map") !== typeIdx ||
      this.ctx.typeIdxToStructName.get(typeIdx) !== "Map"
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `native Map carrier ${typeIdx} is not the canonical allocator-owned Map struct`,
      );
    }
    const cell = this.session.typeCellFor(type) ?? this.session.createTypeCell(type);
    const existing = this.nativeMapCarrierSupport;
    if (existing) {
      if (existing.type !== type || existing.cell !== cell) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          "one compilation selected more than one physical native Map carrier",
        );
      }
      return existing.ref;
    }
    const ref = irSupportTypeRef(canonicalEntrySource(this.session), "native-map-carrier", "__ir_native_map_carrier");
    this.planPreparedSupportType(ref, type, cell, PROGRAM_ABI_TYPE_ROLE.nativeMapCarrier, 0);
    this.nativeMapCarrierSupport = Object.freeze({ ref, type, cell });
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

  /**
   * Plan the exact physical type population already allocated for a batch of
   * compiler-owned closures.
   *
   * The batch boundary is deliberate: semantic signature/layout keys are
   * sorted before structural ordinals are assigned, so caller traversal and
   * closure creation order cannot perturb Program ABI ordering. Repeating the
   * exact batch is idempotent; adding a new semantic layout later fails rather
   * than silently changing earlier ordinals.
   */
  prepareClosureSupportLayouts(
    requests: readonly ProgramAbiClosureSupportLayoutRequest[],
  ): readonly ProgramAbiClosureSupportLayout[] {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot prepare closure support after retained type planning",
      );
    }
    if (requests.length === 0) return [];

    const canonical = requests.map((request) => {
      const signatureKey = canonicalProgramAbiClosureSignatureKey(request.signature);
      const layoutKey = canonicalProgramAbiClosureLayoutKey(
        request.signature,
        request.captureFieldTypes,
        request.domCallbackAuthorityKey,
      );
      this.validateAllocatedClosureSupport(request, signatureKey);
      return { request, signatureKey, layoutKey } satisfies CanonicalClosureSupportRequest;
    });

    if (this.closureSupportBatchPlanned) {
      return canonical.map(({ request, layoutKey }) => {
        const observed = this.closureSupportLayouts.get(layoutKey);
        if (!observed) {
          throw new ProgramAbiInvariantError(
            "planning-sealed",
            `closure support layout ${layoutKey} was requested after the canonical batch was planned`,
          );
        }
        this.assertSameClosurePhysicalLayout(observed.request, request, layoutKey);
        if (closureSupportRoleRank(request.role) > closureSupportRoleRank(observed.request.role)) {
          throw new ProgramAbiInvariantError(
            "planning-sealed",
            `closure support layout ${layoutKey} expanded from ${observed.request.role} to ${request.role} after ` +
              "the canonical batch was planned",
          );
        }
        return observed.layout;
      });
    }

    const first = canonical[0]!;
    for (const candidate of canonical) {
      if (candidate.request.wrapperRootType !== first.request.wrapperRootType) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          "one closure support batch references more than one physical wrapper root",
        );
      }
    }

    const bySignature = new Map<string, CanonicalClosureSupportRequest>();
    const byLayout = new Map<string, CanonicalClosureSupportRequest>();
    let rootAllocationSignatureKey: string | undefined;
    for (const candidate of canonical) {
      const priorSignature = bySignature.get(candidate.signatureKey);
      if (priorSignature) {
        if (
          priorSignature.request.allocationWrapperType !== candidate.request.allocationWrapperType ||
          priorSignature.request.liftedFuncType !== candidate.request.liftedFuncType
        ) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `closure signature ${candidate.signatureKey} maps to different physical wrapper/funcref types`,
          );
        }
        bySignature.set(candidate.signatureKey, strongestClosureSupportRequest(priorSignature, candidate));
      } else {
        bySignature.set(candidate.signatureKey, candidate);
      }

      const priorLayout = byLayout.get(candidate.layoutKey);
      if (priorLayout) {
        this.assertSameClosurePhysicalLayout(priorLayout.request, candidate.request, candidate.layoutKey);
        byLayout.set(candidate.layoutKey, strongestClosureSupportRequest(priorLayout, candidate));
      } else {
        byLayout.set(candidate.layoutKey, candidate);
      }

      if (
        candidate.request.role === "allocate" &&
        candidate.request.allocationWrapperType === candidate.request.wrapperRootType
      ) {
        if (rootAllocationSignatureKey !== undefined && rootAllocationSignatureKey !== candidate.signatureKey) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            "the physical closure wrapper root is claimed by more than one semantic signature",
          );
        }
        rootAllocationSignatureKey = candidate.signatureKey;
      }
    }

    const signatureOrdinals = new Map([...bySignature.keys()].sort().map((key, index) => [key, index] as const));
    const layoutOrdinals = new Map([...byLayout.keys()].sort().map((key, index) => [key, index] as const));
    const rootRef = this.planClosureSupportType({
      semanticRole: "wrapper-root",
      adapterName: "__ir_closure_wrapper_root",
      type: first.request.wrapperRootType,
      roleOrdinal: PROGRAM_ABI_TYPE_ROLE.closureWrapperRoot,
      derivedOrdinal: 0,
    });

    const resultByLayout = new Map<string, ProgramAbiClosureSupportLayout>();
    for (const [signatureKey, candidate] of [...bySignature].sort(([left], [right]) => left.localeCompare(right))) {
      const signatureOrdinal = signatureOrdinals.get(signatureKey)!;
      const allocatesSignature = candidate.request.role === "allocate";
      const invokesSignature = allocatesSignature || candidate.request.role === "invoke";
      const allocationWrapperRef =
        candidate.request.allocationWrapperType === candidate.request.wrapperRootType
          ? rootRef
          : this.closureSupportTypeRef(
              {
                semanticRole: `signature-wrapper:${signatureKey}`,
                adapterName: `__ir_closure_wrapper_${signatureOrdinal}`,
                type: candidate.request.allocationWrapperType,
                roleOrdinal: PROGRAM_ABI_TYPE_ROLE.closureSignatureWrapper,
                derivedOrdinal: signatureOrdinal,
              },
              allocatesSignature,
            );
      const liftedFuncRef = this.closureSupportTypeRef(
        {
          semanticRole: `lifted-func:${signatureKey}`,
          adapterName: `__ir_closure_lifted_func_${signatureOrdinal}`,
          type: candidate.request.liftedFuncType,
          roleOrdinal: PROGRAM_ABI_TYPE_ROLE.closureLiftedFunc,
          derivedOrdinal: signatureOrdinal,
        },
        invokesSignature,
      );

      for (const [layoutKey, layoutCandidate] of [...byLayout]
        .filter(([, value]) => value.signatureKey === signatureKey)
        .sort(([left], [right]) => left.localeCompare(right))) {
        const layoutOrdinal = layoutOrdinals.get(layoutKey)!;
        const allocatesLayout = layoutCandidate.request.role === "allocate";
        const capturedSubtypeRef =
          layoutCandidate.request.capturedSubtypeType === layoutCandidate.request.allocationWrapperType
            ? allocationWrapperRef
            : this.closureSupportTypeRef(
                {
                  semanticRole: `captured-subtype:${layoutKey}`,
                  adapterName: `__ir_closure_captured_${layoutOrdinal}`,
                  type: layoutCandidate.request.capturedSubtypeType,
                  roleOrdinal: PROGRAM_ABI_TYPE_ROLE.closureCapturedSubtype,
                  derivedOrdinal: layoutOrdinal,
                },
                allocatesLayout,
              );
        resultByLayout.set(
          layoutKey,
          Object.freeze({
            semanticSignatureKey: signatureKey,
            semanticLayoutKey: layoutKey,
            wrapperRootRef: rootRef,
            allocationWrapperRef,
            liftedFuncRef,
            capturedSubtypeRef,
          }),
        );
      }
    }

    for (const [layoutKey, candidate] of byLayout) {
      this.closureSupportLayouts.set(
        layoutKey,
        Object.freeze({ request: candidate.request, layout: resultByLayout.get(layoutKey)! }),
      );
    }
    this.closureSupportBatchPlanned = true;
    return canonical.map(({ layoutKey }) => resultByLayout.get(layoutKey)!);
  }

  /**
   * Plan the canonical physical ref-cell structs used by mutable IR captures.
   * Semantic payload keys are sorted before ordinals are assigned so nested
   * function traversal cannot perturb the Program ABI.
   */
  prepareRefCellSupportTypes(
    requests: readonly ProgramAbiRefCellSupportRequest[],
  ): readonly ProgramAbiRefCellSupport[] {
    if (this.planned) {
      throw new ProgramAbiInvariantError("planning-sealed", "cannot prepare ref-cell support after retained planning");
    }
    if (requests.length === 0) return [];

    const canonical = requests.map((request) => {
      const semanticInnerTypeKey = canonicalProgramAbiRefCellKey(request.innerType);
      const index = this.requireUniqueAllocatedType(request.cellType, `ref-cell ${semanticInnerTypeKey}`);
      const field = request.cellType.fields[0];
      if (
        request.cellType.fields.length !== 1 ||
        field?.name !== "value" ||
        field.mutable !== true ||
        request.cellType.superTypeIdx !== undefined ||
        index < 0
      ) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `ref-cell ${semanticInnerTypeKey} does not use the canonical mutable value-field layout`,
        );
      }
      return { request, semanticInnerTypeKey };
    });

    if (this.refCellSupportBatchPlanned) {
      return canonical.map(({ request, semanticInnerTypeKey }) => {
        const observed = this.refCellSupport.get(semanticInnerTypeKey);
        if (!observed) {
          throw new ProgramAbiInvariantError(
            "planning-sealed",
            `ref-cell support ${semanticInnerTypeKey} was requested after the canonical batch was planned`,
          );
        }
        if (observed.request.cellType !== request.cellType) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `ref-cell support ${semanticInnerTypeKey} maps to different physical type objects`,
          );
        }
        return observed.support;
      });
    }

    const byKey = new Map<string, ProgramAbiRefCellSupportRequest>();
    for (const { request, semanticInnerTypeKey } of canonical) {
      const previous = byKey.get(semanticInnerTypeKey);
      if (previous && previous.cellType !== request.cellType) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `ref-cell support ${semanticInnerTypeKey} maps to different physical type objects`,
        );
      }
      byKey.set(semanticInnerTypeKey, request);
    }

    const supportByKey = new Map<string, ProgramAbiRefCellSupport>();
    [...byKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([semanticInnerTypeKey, request], ordinal) => {
        const entrySourceId = canonicalEntrySource(this.session);
        const cellTypeRef = irSupportTypeRef(
          entrySourceId,
          `ref-cell:${semanticInnerTypeKey}`,
          `__ir_ref_cell_${ordinal}`,
          ordinal,
        );
        const cell = this.session.typeCellFor(request.cellType) ?? this.session.createTypeCell(request.cellType);
        this.planPreparedSupportType(cellTypeRef, request.cellType, cell, PROGRAM_ABI_TYPE_ROLE.refCell, ordinal);
        const support = Object.freeze({ semanticInnerTypeKey, cellTypeRef });
        this.refCellSupport.set(semanticInnerTypeKey, Object.freeze({ request, support }));
        supportByKey.set(semanticInnerTypeKey, support);
      });
    this.refCellSupportBatchPlanned = true;
    return canonical.map(({ semanticInnerTypeKey }) => supportByKey.get(semanticInnerTypeKey)!);
  }

  /** Plan closed object layouts referenced by prepared closure signatures. */
  prepareObjectSupportTypes(requests: readonly ProgramAbiObjectSupportRequest[]): readonly ProgramAbiObjectSupport[] {
    if (this.planned) {
      throw new ProgramAbiInvariantError("planning-sealed", "cannot prepare object support after retained planning");
    }
    if (requests.length === 0) return [];
    const canonical = requests.map((request) => {
      const semanticShapeKey = canonicalProgramAbiObjectShapeKey(request.objectType);
      const index = this.requireUniqueAllocatedType(request.structType, `object support ${semanticShapeKey}`);
      if (index < 0 || request.structType.superTypeIdx !== undefined) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `object support ${semanticShapeKey} is not one root struct layout`,
        );
      }
      return { request, semanticShapeKey };
    });

    if (this.objectSupportBatchPlanned) {
      return canonical.map(({ request, semanticShapeKey }) => {
        const observed = this.objectSupport.get(semanticShapeKey);
        if (!observed) {
          throw new ProgramAbiInvariantError(
            "planning-sealed",
            `object support ${semanticShapeKey} was requested after the canonical batch was planned`,
          );
        }
        if (observed.request.structType !== request.structType) {
          throw new ProgramAbiInvariantError(
            "type-remap-mismatch",
            `object support ${semanticShapeKey} maps to different physical type objects`,
          );
        }
        return observed.support;
      });
    }

    const byKey = new Map<string, ProgramAbiObjectSupportRequest>();
    for (const { request, semanticShapeKey } of canonical) {
      const previous = byKey.get(semanticShapeKey);
      if (previous && previous.structType !== request.structType) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `object support ${semanticShapeKey} maps to different physical type objects`,
        );
      }
      byKey.set(semanticShapeKey, request);
    }

    const supportByKey = new Map<string, ProgramAbiObjectSupport>();
    [...byKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([semanticShapeKey, request], ordinal) => {
        const entrySourceId = canonicalEntrySource(this.session);
        const objectTypeRef = irSupportTypeRef(
          entrySourceId,
          `object-layout:${semanticShapeKey}`,
          `__ir_object_layout_${ordinal}`,
          ordinal,
        );
        const cell = this.session.typeCellFor(request.structType) ?? this.session.createTypeCell(request.structType);
        this.planPreparedSupportType(
          objectTypeRef,
          request.structType,
          cell,
          PROGRAM_ABI_TYPE_ROLE.objectLayout,
          ordinal,
        );
        const support = Object.freeze({ semanticShapeKey, objectTypeRef });
        this.objectSupport.set(semanticShapeKey, Object.freeze({ request, support }));
        supportByKey.set(semanticShapeKey, support);
      });
    this.objectSupportBatchPlanned = true;
    return canonical.map(({ semanticShapeKey }) => supportByKey.get(semanticShapeKey)!);
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

  private validateAllocatedClosureSupport(request: ProgramAbiClosureSupportLayoutRequest, signatureKey: string): void {
    const rootIndex = this.requireUniqueAllocatedType(request.wrapperRootType, "closure wrapper root");
    const wrapperIndex = this.requireUniqueAllocatedType(request.allocationWrapperType, "closure signature wrapper");
    this.requireUniqueAllocatedType(request.liftedFuncType, "closure lifted function type");
    const subtypeIndex = this.requireUniqueAllocatedType(request.capturedSubtypeType, "closure captured subtype");

    // (#4241) Derived from the shared header layout, NOT restated here. This
    // check used to spell the layout out as `length === 2 && funcref && i32`;
    // when the `$bag` slot was inserted at index 2 the mint sites and this
    // validator disagreed, and the disagreement did not warn — it THREW, so
    // every async function in the playground examples failed IR-first with
    // "non-canonical physical wrapper root" and `check:ir-only` exited 1.
    const hasCanonicalWrapperFields = (type: StructTypeDef): boolean => isCanonicalClosureHeader(type.fields);
    if (!hasCanonicalWrapperFields(request.wrapperRootType)) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `closure signature ${signatureKey} has a non-canonical physical wrapper root`,
      );
    }
    if (
      request.allocationWrapperType !== request.wrapperRootType &&
      (!hasCanonicalWrapperFields(request.allocationWrapperType) ||
        request.allocationWrapperType.superTypeIdx !== rootIndex)
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `closure signature ${signatureKey} has a wrapper outside the canonical root hierarchy`,
      );
    }

    const self = request.liftedFuncType.params[0];
    if (
      request.liftedFuncType.params.length !== request.signature.params.length + 1 ||
      request.liftedFuncType.results.length !== (request.signature.returnType === null ? 0 : 1) ||
      (self?.kind !== "ref" && self?.kind !== "ref_null") ||
      self.typeIdx !== rootIndex
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `closure signature ${signatureKey} has a mismatched lifted function type`,
      );
    }

    if (request.captureFieldTypes.length === 0 && request.domCallbackAuthorityKey === undefined) {
      if (request.capturedSubtypeType !== request.allocationWrapperType) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `capture-free closure signature ${signatureKey} allocated a redundant subtype`,
        );
      }
    } else if (
      request.capturedSubtypeType === request.allocationWrapperType ||
      request.capturedSubtypeType.superTypeIdx !== wrapperIndex ||
      request.capturedSubtypeType.fields.length !==
        closureSubtypeFieldCount(request.captureFieldTypes.length) +
          (request.domCallbackAuthorityKey === undefined ? 0 : 1) ||
      !hasClosureHeaderPrefix(request.capturedSubtypeType.fields)
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `closure layout ${signatureKey} has a mismatched captured subtype at ${subtypeIndex}`,
      );
    }
    if (request.domCallbackAuthorityKey !== undefined) {
      const authorityField = request.capturedSubtypeType.fields.at(-1);
      if (
        authorityField?.name !== DOM_CALLBACK_AUTHORITY_FIELD ||
        authorityField.mutable ||
        authorityField.type.kind !== "ref"
      ) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `DOM callback closure layout ${signatureKey} has no exact authority field at ${subtypeIndex}`,
        );
      }
    }
  }

  private assertSameClosurePhysicalLayout(
    previous: ProgramAbiClosureSupportLayoutRequest,
    next: ProgramAbiClosureSupportLayoutRequest,
    layoutKey: string,
  ): void {
    if (
      previous.wrapperRootType !== next.wrapperRootType ||
      previous.allocationWrapperType !== next.allocationWrapperType ||
      previous.liftedFuncType !== next.liftedFuncType ||
      previous.capturedSubtypeType !== next.capturedSubtypeType
    ) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `closure support semantic layout ${layoutKey} maps to different physical type objects`,
      );
    }
  }

  private requireUniqueAllocatedType(type: TypeDef, label: string): number {
    const index = this.ctx.mod.types.indexOf(type);
    if (index < 0 || this.ctx.mod.types.indexOf(type, index + 1) >= 0) {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `${label} must be one exact existing allocator type object`,
      );
    }
    return index;
  }

  private closureSupportTypeRef(
    input: {
      readonly semanticRole: string;
      readonly adapterName: string;
      readonly type: TypeDef;
      readonly roleOrdinal: number;
      readonly derivedOrdinal: number;
    },
    plan = true,
  ): IrTypeRef {
    const entrySourceId = canonicalEntrySource(this.session);
    const ref = irSupportTypeRef(
      entrySourceId,
      `closure-support:${input.semanticRole}`,
      input.adapterName,
      input.derivedOrdinal,
    );
    if (!plan) return ref;
    const cell = this.session.typeCellFor(input.type) ?? this.session.createTypeCell(input.type);
    const previousOwner = this.session.locatorBindingId(cell);
    if (previousOwner !== undefined && previousOwner !== ref.binding.bindingId) {
      const previousDraft = this.session.getDraft(previousOwner);
      if (previousDraft?.intent.kind !== "type") {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `closure support type ${input.semanticRole} shares a physical type with non-type binding ${previousOwner}`,
        );
      }
      const canonicalRef = Object.freeze({
        ...ref,
        binding: Object.freeze({ kind: "support" as const, bindingId: previousOwner }),
      });
      if (previousDraft.structuralReferenceKey !== irTypeBindingKey(canonicalRef.binding)) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          `closure support type ${input.semanticRole} cannot reuse non-support type binding ${previousOwner}`,
        );
      }
      return canonicalRef;
    }
    this.planPreparedSupportType(ref, input.type, cell, input.roleOrdinal, input.derivedOrdinal);
    return ref;
  }

  private planClosureSupportType(input: {
    readonly semanticRole: string;
    readonly adapterName: string;
    readonly type: TypeDef;
    readonly roleOrdinal: number;
    readonly derivedOrdinal: number;
  }): IrTypeRef {
    return this.closureSupportTypeRef(input);
  }
}
