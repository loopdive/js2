// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "./identity.js";
import type { IrFuncRef, IrFunction, IrInstr, IrType, IrTypeRef, IrValueId } from "./nodes.js";
import type { ValType } from "./types.js";

/** Exact post-pass closure support prepared against allocator-owned objects. */
export interface PreparedComponentClosureSupportEvidence {
  readonly typeRefs: ReadonlyMap<IrType, readonly IrTypeRef[]>;
  readonly instructionRefs: ReadonlyMap<IrInstr, readonly IrTypeRef[]>;
  readonly functionRefs: ReadonlyMap<IrFunction, readonly IrTypeRef[]>;
}

/** Exact proof for a dynamic class-setter writeback and its support types. */
export interface PreparedClassAccessorWritebackEvidence {
  readonly valueGlobalBindingId: IrBindingId;
  readonly tdzGlobalBindingId?: IrBindingId;
  readonly tdzExceptionTagTypeRef?: IrTypeRef;
  readonly dynamicCarrierRef: IrTypeRef;
  readonly dynamicCarrierValueType: string;
}

/** Object-identity keyed callable or exact identity-lowering authority. */
export interface PreparedDynamicInstructionSupportEvidence {
  readonly dynamicCarrierRef: IrTypeRef;
  readonly instructionCallables: ReadonlyMap<IrInstr, readonly IrFuncRef[]>;
  /** Exact empty lowering; never treat an absent/empty callable list as proof. */
  readonly identityBoxes?: ReadonlyMap<IrInstr, { readonly operandType: IrType; readonly carrier: ValType }>;
}

export interface PreparedInstructionSupportSidecars {
  readonly closureSupport?: PreparedComponentClosureSupportEvidence;
  readonly classAccessorWritebacks?: ReadonlyMap<IrUnitId, PreparedClassAccessorWritebackEvidence>;
  readonly dynamicInstructionSupport?: ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence>;
}

export interface PreparedInstructionSupport {
  readonly typeRefs: readonly IrTypeRef[] | undefined;
  readonly callableRefs: readonly IrFuncRef[];
  readonly hasPreparedSupport: boolean;
}

export function preparedDynamicCarrierRef(
  ownerUnitId: IrUnitId,
  sidecars: PreparedInstructionSupportSidecars,
): IrTypeRef | undefined {
  return (
    sidecars.classAccessorWritebacks?.get(ownerUnitId)?.dynamicCarrierRef ??
    sidecars.dynamicInstructionSupport?.get(ownerUnitId)?.dynamicCarrierRef
  );
}

/** Resolve exact sidecars for one final-IR instruction without spelling authority. */
export function preparedInstructionSupport(
  instr: IrInstr,
  ownerUnitId: IrUnitId,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
  functionTypeRefs: readonly IrTypeRef[] | undefined,
  sidecars: PreparedInstructionSupportSidecars,
): PreparedInstructionSupport {
  const typeRefs = sidecars.closureSupport?.instructionRefs.get(instr);
  const dynamicSupport = sidecars.dynamicInstructionSupport?.get(ownerUnitId);
  const callableRefs = dynamicSupport?.instructionCallables.get(instr) ?? [];
  const identity = dynamicSupport?.identityBoxes?.get(instr);
  const identityBox =
    instr.kind === "box" &&
    instr.toType.kind === "dynamic" &&
    identity?.carrier.kind === "externref" &&
    identity.operandType.kind === "extern" &&
    identity.operandType === valueTypes.get(instr.value);
  const objectType =
    instr.kind === "object.new"
      ? instr.resultType
      : instr.kind === "object.get" || instr.kind === "object.set"
        ? valueTypes.get(instr.value)
        : undefined;
  return {
    typeRefs,
    callableRefs,
    hasPreparedSupport:
      instr.kind === "closure.cap"
        ? (functionTypeRefs?.length ?? 0) > 0
        : (typeRefs?.length ?? 0) > 0 ||
          callableRefs.length > 0 ||
          identityBox ||
          (objectType?.kind === "object" && (sidecars.closureSupport?.typeRefs.get(objectType)?.length ?? 0) > 0),
  };
}
