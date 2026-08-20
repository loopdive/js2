// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { getFuncRefWrapperRootTypeIdx, type ClosureAllocationMode } from "../codegen/closures/funcref-wrapper-types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../codegen/func-space.js";
import type {
  ProgramAbiClosureSupportLayout,
  ProgramAbiClosureSupportLayoutRequest,
  ProgramAbiClosureSupportRole,
  ProgramAbiRefCellSupportRequest,
} from "../codegen/program-abi-type-planning.js";
import { addFuncType } from "../codegen/registry/types.js";
import { irTypeBindingKey } from "./abi-bindings.js";
import type { IrUnitId } from "./identity.js";
import type { PreparedComponentClosureSupportEvidence } from "./prepared-component-dependencies.js";
import { IrInvariantError } from "./outcomes.js";
import {
  forEachInstrDeep,
  type IrClosureSignature,
  type IrDomCallbackAuthority,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrTypeRef,
} from "./nodes.js";
import type { IrClosureLowering, IrRefCellLowering } from "./lower.js";
import type { FieldDef, FuncTypeDef, StructTypeDef, ValType, WasmFunction } from "./types.js";

export interface PreparedClosureRegistry {
  resolveBase(signature: IrClosureSignature, mode?: ClosureAllocationMode): IrClosureLowering | null;
  resolveSubtype(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    mode?: ClosureAllocationMode,
    domCallbackAuthority?: IrDomCallbackAuthority,
  ): IrClosureLowering | null;
}

export interface PreparedRefCellRegistry {
  resolveIr(inner: IrType): IrRefCellLowering | null;
}

function preparedObjectLegacyKey(fields: readonly FieldDef[]): string {
  return fields
    .map(({ name, type }) =>
      type.kind === "ref" || type.kind === "ref_null" ? `${name}:${type.kind}:${type.typeIdx}` : `${name}:${type.kind}`,
    )
    .join("|");
}

/**
 * Allocate a closed object layout before closure signatures are frozen. This
 * mirrors ObjectStructRegistry's anonymous-struct contract, including nullable
 * reference fields and legacy hash deduplication, but is intentionally reached
 * only from prepare-time closure type resolution.
 */
function prepareClosureObjectType(
  ctx: CodegenContext,
  type: Extract<IrType, { readonly kind: "object" }>,
  refCells?: PreparedRefCellRegistry,
  closures?: PreparedClosureRegistry,
): ValType {
  const fields: FieldDef[] = type.shape.fields.map((field) => {
    let physical = lowerPreparedClosureSupportType(ctx, field.type, refCells, closures);
    if (physical.kind === "ref") physical = { kind: "ref_null", typeIdx: physical.typeIdx };
    return { name: field.name, type: physical, mutable: true };
  });
  const key = preparedObjectLegacyKey(fields);
  const existingName = ctx.anonStructHash.get(key);
  if (existingName !== undefined) {
    const existingIdx = ctx.structMap.get(existingName);
    if (existingIdx === undefined) throw new Error("prepared closure object hash lost its struct allocation");
    return { kind: "ref", typeIdx: existingIdx };
  }

  const name = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  ctx.anonStructHash.set(key, name);
  return { kind: "ref", typeIdx };
}

export function lowerPreparedClosureSupportType(
  ctx: CodegenContext,
  type: IrType,
  refCells?: PreparedRefCellRegistry,
  closures?: PreparedClosureRegistry,
): ValType {
  if (type.kind === "val" && type.val.kind !== "ref" && type.val.kind !== "ref_null") return type.val;
  if (type.kind === "extern" || type.kind === "callable") return { kind: "externref" };
  if (type.kind === "string" && type.carrierRef && ctx.programAbiSession) {
    const ref = type.carrierRef;
    const draft = ctx.programAbiSession.getDraft(ref.binding.bindingId);
    if (draft?.intent.kind !== "type" || draft.structuralReferenceKey !== irTypeBindingKey(ref.binding)) {
      throw new Error("prepared closure string carrier has no exact Program ABI type plan");
    }
    if (draft.slotPolicy === "none") {
      if (draft.intent.shapeKey !== JSON.stringify({ kind: "externref" })) {
        throw new Error("prepared closure string carrier is not the canonical externref value type");
      }
      return { kind: "externref" };
    }
    return {
      kind: "ref",
      typeIdx: ctx.programAbiSession.resolveCurrentIndex(ref.binding.bindingId, "type", irTypeBindingKey(ref.binding)),
    };
  }
  if (type.kind === "vec" && type.layout && ctx.programAbiSession) {
    return {
      kind: type.nullable ? "ref_null" : "ref",
      typeIdx: ctx.programAbiSession.resolveCurrentIndex(
        type.layout.carrierType.binding.bindingId,
        "type",
        irTypeBindingKey(type.layout.carrierType.binding),
      ),
    };
  }
  if (type.kind === "object") return prepareClosureObjectType(ctx, type, refCells, closures);
  if (type.kind === "closure" && closures) {
    if (!closures.resolveBase(type.signature)) {
      throw new Error("prepared object field cannot allocate its closure signature");
    }
    const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
    if (rootTypeIdx === undefined) throw new Error("prepared object field has no closure wrapper root");
    return { kind: "ref", typeIdx: rootTypeIdx };
  }
  if (type.kind === "boxed" && refCells) {
    const cell = refCells.resolveIr(type.inner);
    if (cell) return { kind: "ref", typeIdx: cell.typeIdx };
  }
  throw new Error(`closure support type ${type.kind} requires the complete IR resolver`);
}

export function prepareDerivedCallableTypeIdx(
  ctx: CodegenContext,
  registry: PreparedClosureRegistry,
  fn: IrFunction,
): number {
  const lower = (type: IrType): ValType => {
    if (type.kind !== "closure") return lowerPreparedClosureSupportType(ctx, type, undefined, registry);
    if (!registry.resolveBase(type.signature)) {
      throw new Error("prepared callable signature cannot allocate its closure type");
    }
    const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
    if (rootTypeIdx === undefined) throw new Error("prepared callable signature has no closure wrapper root");
    return { kind: "ref", typeIdx: rootTypeIdx };
  };
  return addFuncType(
    ctx,
    fn.params.map(({ type }) => lower(type)),
    fn.resultTypes.map(lower),
    fn.name,
  );
}

export interface PreparedDerivedCallableSlot {
  readonly artifactUnitId: IrUnitId;
  readonly funcIdx: number;
  readonly terminalOwnerUnitId: IrUnitId;
}

export function allocatePreparedDerivedCallableSlots(
  ctx: CodegenContext,
  entries: readonly {
    readonly artifactUnitId: IrUnitId;
    readonly terminalOwnerUnitId: IrUnitId;
    readonly name: string;
    readonly fn: IrFunction;
    readonly synthesized?: boolean;
    readonly classMember?: boolean;
    readonly moduleInit?: boolean;
  }[],
  originalArtifactUnitIds: ReadonlySet<IrUnitId>,
  registry: PreparedClosureRegistry,
): readonly PreparedDerivedCallableSlot[] {
  const slots: PreparedDerivedCallableSlot[] = [];
  for (const entry of entries) {
    if (originalArtifactUnitIds.has(entry.artifactUnitId) && !entry.synthesized) continue;
    if (entry.classMember || entry.moduleInit || ctx.irUnitFuncMap.has(entry.artifactUnitId)) continue;
    // Declaration-body compilation still projects allocator slots by
    // compatibility name. A source function may reuse a lifted display name,
    // so an early derived slot must stay outside that legacy name map.
    const physicalName = ctx.funcMap.has(entry.name) ? `__\0js2_ir_prepared_derived_${slots.length}` : entry.name;
    const func: WasmFunction = {
      name: physicalName,
      typeIdx: prepareDerivedCallableTypeIdx(ctx, registry, entry.fn),
      locals: [],
      body: [],
      exported: entry.fn.exported,
    };
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, func);
    ctx.irUnitFuncMap.set(entry.artifactUnitId, func);
    slots.push({
      artifactUnitId: entry.artifactUnitId,
      funcIdx,
      terminalOwnerUnitId: entry.terminalOwnerUnitId,
    });
  }
  return slots;
}

function requireStructType(ctx: CodegenContext, typeIdx: number, label: string): StructTypeDef {
  const type = ctx.mod.types[typeIdx];
  if (!type || type.kind !== "struct") {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "resolve",
      `prepared closure ${label} has no exact allocated struct type at ${typeIdx}`,
    );
  }
  return type;
}

function requireFuncType(ctx: CodegenContext, typeIdx: number): FuncTypeDef {
  const type = ctx.mod.types[typeIdx];
  if (!type || type.kind !== "func") {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "resolve",
      `prepared closure lifted callable has no exact allocated function type at ${typeIdx}`,
    );
  }
  return type;
}

function distinctRefs(
  layout: ProgramAbiClosureSupportLayout,
  role: ProgramAbiClosureSupportRole,
): readonly IrTypeRef[] {
  const refs =
    role === "carrier"
      ? [layout.wrapperRootRef]
      : role === "invoke"
        ? [layout.wrapperRootRef, layout.liftedFuncRef]
        : [layout.wrapperRootRef, layout.allocationWrapperRef, layout.liftedFuncRef, layout.capturedSubtypeRef];
  return Object.freeze([...new Map(refs.map((ref) => [irTypeBindingKey(ref.binding), ref] as const)).values()]);
}

/** Prepare exact final-IR closure types and publish identity-keyed ABI evidence. */
export function prepareDependencyCompleteClosureSupport(
  ctx: CodegenContext,
  entries: readonly { readonly fn: IrFunction }[],
  registry: PreparedClosureRegistry,
  refCells: PreparedRefCellRegistry,
): PreparedComponentClosureSupportEvidence {
  const typeRefs = new Map<IrType, readonly IrTypeRef[]>();
  const instructionRefs = new Map<IrInstr, readonly IrTypeRef[]>();
  const functionRefs = new Map<IrFunction, readonly IrTypeRef[]>();
  const pending: Array<{
    readonly request: ProgramAbiClosureSupportLayoutRequest;
    readonly role: ProgramAbiClosureSupportRole;
    readonly publish: (refs: readonly IrTypeRef[]) => void;
  }> = [];
  const pendingRefCells: Array<{
    readonly request: ProgramAbiRefCellSupportRequest;
    readonly publish: (refs: readonly IrTypeRef[]) => void;
  }> = [];

  const objectTypes = new Map<Extract<IrType, { readonly kind: "object" }>, StructTypeDef>();
  const seenObjectSupportTypes = new Set<IrType>();
  const collectObjectSupport = (type: IrType): void => {
    if (seenObjectSupportTypes.has(type)) return;
    seenObjectSupportTypes.add(type);
    switch (type.kind) {
      case "object": {
        for (const field of type.shape.fields) collectObjectSupport(field.type);
        const physical = prepareClosureObjectType(ctx, type, refCells, registry);
        if (physical.kind !== "ref" && physical.kind !== "ref_null") {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            "prepared closure object support did not produce a reference type",
          );
        }
        const struct = ctx.mod.types[physical.typeIdx];
        if (!struct || struct.kind !== "struct") {
          throw new IrInvariantError(
            "selection-preparation-mismatch",
            "resolve",
            "prepared closure object support allocated no exact struct layout",
          );
        }
        objectTypes.set(type, struct);
        return;
      }
      case "closure":
      case "callable":
        for (const param of type.signature.params) collectObjectSupport(param);
        if (type.signature.returnType) collectObjectSupport(type.signature.returnType);
        return;
      case "vec":
        collectObjectSupport(type.elementType);
        return;
      case "boxed":
        collectObjectSupport(type.inner);
        return;
      case "union":
        for (const member of type.members) collectObjectSupport(member);
        return;
      case "val":
      case "string":
      case "class":
      case "extern":
      case "dynamic":
        return;
    }
  };

  for (const { fn } of entries) {
    for (const param of fn.params) collectObjectSupport(param.type);
    for (const result of fn.resultTypes) collectObjectSupport(result);
    for (const capture of fn.closureSubtype?.captureFieldTypes ?? []) collectObjectSupport(capture);
    for (const block of fn.blocks) {
      for (const type of block.blockArgTypes) collectObjectSupport(type);
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.resultType) collectObjectSupport(nested.resultType);
          if (nested.kind === "closure.new") {
            for (const param of nested.signature.params) collectObjectSupport(param);
            if (nested.signature.returnType) collectObjectSupport(nested.signature.returnType);
            for (const capture of nested.captureFieldTypes) collectObjectSupport(capture);
          }
        });
      }
    }
  }

  if (objectTypes.size > 0) {
    const programAbiTypes = ctx.programAbiTypes;
    if (!programAbiTypes) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared object support requires one canonical Program ABI type registry",
      );
    }
    const requests = [...objectTypes].map(([objectType, structType]) => ({ objectType, structType }));
    const support = programAbiTypes.prepareObjectSupportTypes(requests);
    support.forEach((entry, index) => typeRefs.set(requests[index]!.objectType, [entry.objectTypeRef]));
  }

  const scheduleRefCell = (
    boxedType: Extract<IrType, { readonly kind: "boxed" }>,
    publish: (refs: readonly IrTypeRef[]) => void,
  ): void => {
    const lowering = refCells.resolveIr(boxedType.inner);
    const cellType = lowering ? ctx.mod.types[lowering.typeIdx] : undefined;
    if (!lowering || cellType?.kind !== "struct") return;
    pendingRefCells.push({ request: { innerType: boxedType.inner, cellType }, publish });
  };
  const schedule = (
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    role: ProgramAbiClosureSupportRole,
    publish: (refs: readonly IrTypeRef[]) => void,
    mode: ClosureAllocationMode = "support",
    domCallbackAuthority?: IrDomCallbackAuthority,
  ): void => {
    const base = registry.resolveBase(signature, mode);
    const subtype = registry.resolveSubtype(signature, captureFieldTypes, mode, domCallbackAuthority);
    if (!base || !subtype) return;
    const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
    if (rootTypeIdx === undefined) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared closure support allocated no canonical wrapper root",
      );
    }
    pending.push({
      request: {
        signature,
        captureFieldTypes,
        role,
        wrapperRootType: requireStructType(ctx, rootTypeIdx, "wrapper root"),
        allocationWrapperType: requireStructType(ctx, base.structTypeIdx, "signature wrapper"),
        liftedFuncType: requireFuncType(ctx, base.funcTypeIdx),
        capturedSubtypeType: requireStructType(ctx, subtype.structTypeIdx, "captured subtype"),
        ...(domCallbackAuthority
          ? {
              domCallbackAuthorityKey: `${domCallbackAuthority.ownerUnitId}\0${domCallbackAuthority.liftedOrdinal}`,
            }
          : {}),
      },
      role,
      publish,
    });
  };

  for (const { fn } of entries) {
    const valueTypes = new Map(fn.params.map((param) => [param.value, param.type] as const));
    const exactTypes = new Set<IrType>([
      ...fn.params.map((param) => param.type),
      ...fn.resultTypes,
      ...fn.blocks.flatMap((block) => block.blockArgTypes),
      ...(fn.closureSubtype?.captureFieldTypes ?? []),
    ]);
    for (const block of fn.blocks) {
      block.blockArgs.forEach((value, index) => {
        const type = block.blockArgTypes[index];
        if (type) valueTypes.set(value, type);
      });
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.result !== null && nested.resultType !== null) valueTypes.set(nested.result, nested.resultType);
          if (nested.resultType) exactTypes.add(nested.resultType);
        });
      }
    }
    for (const type of exactTypes) {
      if (type.kind === "closure") {
        schedule(type.signature, [], "carrier", (refs) => typeRefs.set(type, refs));
      } else if (type.kind === "callable") {
        // Callable values cross the public boundary as externref. Recording an
        // explicit empty proof distinguishes that complete carrier contract
        // from missing preparation without pinning a speculative wrapper. We
        // still resolve the signature in the canonical batch: wrapper-root
        // allocation order is a compilation-wide ABI invariant shared with
        // legacy closures, even when this exact carrier needs no type ref.
        schedule(type.signature, [], "carrier", () => typeRefs.set(type, Object.freeze([])));
      } else if (type.kind === "boxed") {
        scheduleRefCell(type, (refs) => typeRefs.set(type, refs));
      }
    }
    if (fn.closureSubtype) {
      schedule(
        fn.closureSubtype.signature,
        fn.closureSubtype.captureFieldTypes,
        "allocate",
        (refs) => functionRefs.set(fn, refs),
        fn.closureSubtype.hostOneShot ? "host-one-shot" : "ordinary",
        fn.closureSubtype.domCallbackAuthority,
      );
    }
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.kind === "closure.new") {
            schedule(
              nested.signature,
              nested.captureFieldTypes,
              "allocate",
              (refs) => instructionRefs.set(nested, refs),
              nested.hostOneShot ? "host-one-shot" : "ordinary",
              nested.domCallbackAuthority,
            );
          } else if (nested.kind === "closure.call") {
            const calleeType = valueTypes.get(nested.callee);
            if (calleeType?.kind === "closure" || calleeType?.kind === "callable") {
              schedule(calleeType.signature, [], "invoke", (refs) => instructionRefs.set(nested, refs));
            }
          } else if (nested.kind === "refcell.new" && nested.resultType?.kind === "boxed") {
            scheduleRefCell(nested.resultType, (refs) => instructionRefs.set(nested, refs));
          } else if (nested.kind === "refcell.get" || nested.kind === "refcell.set") {
            const cellType = valueTypes.get(nested.cell);
            if (cellType?.kind === "boxed") {
              scheduleRefCell(cellType, (refs) => instructionRefs.set(nested, refs));
            }
          }
        });
      }
    }
  }

  if (pending.length > 0) {
    const programAbiTypes = ctx.programAbiTypes;
    if (!programAbiTypes) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared closure support requires one canonical Program ABI type registry",
      );
    }
    const layouts = programAbiTypes.prepareClosureSupportLayouts(pending.map(({ request }) => request));
    if (layouts.length !== pending.length) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared closure support planning returned a non-parallel layout population",
      );
    }
    layouts.forEach((layout, index) => {
      const entry = pending[index]!;
      entry.publish(distinctRefs(layout, entry.role));
    });
  }

  if (pendingRefCells.length > 0) {
    const programAbiTypes = ctx.programAbiTypes;
    if (!programAbiTypes) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared ref-cell support requires one canonical Program ABI type registry",
      );
    }
    const support = programAbiTypes.prepareRefCellSupportTypes(pendingRefCells.map(({ request }) => request));
    support.forEach((entry, index) => pendingRefCells[index]!.publish(Object.freeze([entry.cellTypeRef])));
  }
  return Object.freeze({ typeRefs, instructionRefs, functionRefs });
}
