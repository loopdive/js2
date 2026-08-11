// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { getFuncRefWrapperRootTypeIdx, type ClosureAllocationMode } from "../codegen/closures/funcref-wrapper-types.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../codegen/func-space.js";
import type {
  ProgramAbiClosureSupportLayout,
  ProgramAbiClosureSupportLayoutRequest,
} from "../codegen/program-abi-type-planning.js";
import { addFuncType } from "../codegen/registry/types.js";
import { irTypeBindingKey } from "./abi-bindings.js";
import type { IrUnitId } from "./identity.js";
import type { PreparedComponentClosureSupportEvidence } from "./prepared-component-dependencies.js";
import { IrInvariantError } from "./outcomes.js";
import {
  forEachInstrDeep,
  type IrClosureSignature,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrTypeRef,
} from "./nodes.js";
import type { IrClosureLowering } from "./lower.js";
import type { FuncTypeDef, StructTypeDef, ValType, WasmFunction } from "./types.js";

export interface PreparedClosureRegistry {
  resolveBase(signature: IrClosureSignature, mode?: ClosureAllocationMode): IrClosureLowering | null;
  resolveSubtype(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    mode?: ClosureAllocationMode,
  ): IrClosureLowering | null;
}

export function lowerPreparedClosureSupportType(ctx: CodegenContext, type: IrType): ValType {
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
  throw new Error(`closure support type ${type.kind} requires the complete IR resolver`);
}

export function prepareDerivedCallableTypeIdx(
  ctx: CodegenContext,
  registry: PreparedClosureRegistry,
  fn: IrFunction,
): number {
  const lower = (type: IrType): ValType => {
    if (type.kind !== "closure") return lowerPreparedClosureSupportType(ctx, type);
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

function distinctRefs(layout: ProgramAbiClosureSupportLayout): readonly IrTypeRef[] {
  return Object.freeze([
    ...new Map(
      [layout.wrapperRootRef, layout.allocationWrapperRef, layout.liftedFuncRef, layout.capturedSubtypeRef].map(
        (ref) => [irTypeBindingKey(ref.binding), ref] as const,
      ),
    ).values(),
  ]);
}

/** Prepare exact final-IR closure types and publish identity-keyed ABI evidence. */
export function prepareDependencyCompleteClosureSupport(
  ctx: CodegenContext,
  entries: readonly { readonly fn: IrFunction }[],
  registry: PreparedClosureRegistry,
): PreparedComponentClosureSupportEvidence {
  const typeRefs = new Map<IrType, readonly IrTypeRef[]>();
  const instructionRefs = new Map<IrInstr, readonly IrTypeRef[]>();
  const functionRefs = new Map<IrFunction, readonly IrTypeRef[]>();
  const pending: Array<{
    readonly request: ProgramAbiClosureSupportLayoutRequest;
    readonly publish: (refs: readonly IrTypeRef[]) => void;
  }> = [];
  const schedule = (
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    publish: (refs: readonly IrTypeRef[]) => void,
    mode: ClosureAllocationMode = "support",
  ): void => {
    const base = registry.resolveBase(signature, mode);
    const subtype = registry.resolveSubtype(signature, captureFieldTypes, mode);
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
        wrapperRootType: requireStructType(ctx, rootTypeIdx, "wrapper root"),
        allocationWrapperType: requireStructType(ctx, base.structTypeIdx, "signature wrapper"),
        liftedFuncType: requireFuncType(ctx, base.funcTypeIdx),
        capturedSubtypeType: requireStructType(ctx, subtype.structTypeIdx, "captured subtype"),
      },
      publish,
    });
  };

  for (const { fn } of entries) {
    const valueTypes = new Map(fn.params.map((param) => [param.value, param.type] as const));
    const exactTypes = new Set<IrType>([
      ...fn.params.map((param) => param.type),
      ...fn.resultTypes,
      ...fn.blocks.flatMap((block) => block.blockArgTypes),
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
      if (type.kind !== "closure" && type.kind !== "callable") continue;
      schedule(type.signature, [], (refs) => typeRefs.set(type, refs));
    }
    if (fn.closureSubtype) {
      schedule(
        fn.closureSubtype.signature,
        fn.closureSubtype.captureFieldTypes,
        (refs) => functionRefs.set(fn, refs),
        fn.closureSubtype.hostOneShot ? "host-one-shot" : "ordinary",
      );
    }
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (nested.kind === "closure.new") {
            schedule(
              nested.signature,
              nested.captureFieldTypes,
              (refs) => instructionRefs.set(nested, refs),
              nested.hostOneShot ? "host-one-shot" : "ordinary",
            );
          } else if (nested.kind === "closure.call") {
            const calleeType = valueTypes.get(nested.callee);
            if (calleeType?.kind === "closure" || calleeType?.kind === "callable") {
              schedule(calleeType.signature, [], (refs) => instructionRefs.set(nested, refs));
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
    layouts.forEach((layout, index) => pending[index]!.publish(distinctRefs(layout)));
  }
  return Object.freeze({ typeRefs, instructionRefs, functionRefs });
}
