// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The bounded AST producer for the Program-ABI fnctor sidecar.
 *
 * This module records no IR instruction and does not alter the legacy
 * constructor body or call site.  It only observes a constructor after the
 * existing AST compiler has built its reserved struct/function pair.  The
 * deliberately small physical lane here is the one for which the current
 * observation contract has no logical-to-physical field map: one unconditional
 * `input: string` field, no captures/TDZ cells, and no standalone/WASI
 * internal fields or widened foreign result.  The producer is host-only in
 * this checkpoint; other target lanes remain on the legacy path.
 */

import { irFnctorLayoutTypeRef } from "../ir/abi-bindings.js";
import { irFnctorConstructorFuncRef } from "../ir/callable-bindings.js";
import type { IrFnctorShape } from "../ir/fnctor-abi.js";
import type { IrFnctorAdmission } from "../ir/propagate.js";
import type { FieldDef, FuncHandle, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { makeIrFnctorAdmissionResolver } from "./ir-fnctor-admission.js";
import type { FnctorCaptureLayout } from "./fnctor-constructor-identity.js";
import type { ProgramAbiFnctorObservation } from "./program-abi-fnctor-planning.js";
import { canonicalProgramAbiValType } from "./program-abi-signatures.js";

export interface ObserveIrFnctorProducerInput {
  readonly ctx: CodegenContext;
  readonly site: import("../ts-api.js").ts.NewExpression;
  readonly declaration: import("../ts-api.js").ts.FunctionDeclaration;
  readonly functionName: string;
  readonly structName: string;
  readonly structTypeIdx: number;
  readonly fields: readonly FieldDef[];
  readonly captureLayout: FnctorCaptureLayout;
  readonly userParamTypes: readonly ValType[];
  readonly resultIsExternref: boolean;
  readonly constructorFuncIdx: FuncHandle;
  readonly constructorFunction: WasmFunction;
}

function supportsBoundedPhysicalLane(input: ObserveIrFnctorProducerInput): boolean {
  const { ctx } = input;
  // Standalone reserves `$bag`/presence/constructor fields and may use a
  // foreign-result ABI.  Those require a logical-to-physical field map and
  // are intentionally left on the legacy path in this checkpoint.
  if (ctx.standalone || ctx.wasi || input.resultIsExternref) return false;
  if (ctx.fnctorLayoutInfo?.has(input.structName) || ctx.fnctorColdTailTypeIdx?.has(input.functionName)) {
    return false;
  }
  if (ctx.fnctorReservedTypeIdx.get(input.functionName) !== input.structTypeIdx) return false;
  if (ctx.structMap.get(input.structName) !== input.structTypeIdx) return false;
  if (input.captureLayout.captures.length !== 0) return false;
  if (input.captureLayout.valueParamTypes.length !== 0 || input.captureLayout.tdzFlagParamTypes.length !== 0) {
    return false;
  }
  if (input.userParamTypes.length !== 1 || input.fields.length !== 1) return false;
  const field = input.fields[0]!;
  if (
    field.name !== "input" ||
    field.mutable !== true ||
    field.presenceTracked === true ||
    field.dynamicObjectCarrier === true ||
    field.jsBoolean === true
  ) {
    return false;
  }
  // The direct assignment proof normally gives the field and parameter the
  // same physical carrier.  Refuse any mismatch rather than claim a semantic
  // string shape without a target-specific carrier proof.
  return canonicalProgramAbiValType(field.type) === canonicalProgramAbiValType(input.userParamTypes[0]!);
}

function makeBoundedShape(
  admission: IrFnctorAdmission,
  functionName: string,
  structName: string,
  constructorName: string,
  hiddenIdentity: boolean,
): IrFnctorShape {
  const constructorUnitId = admission.constructorUnitId;
  return {
    kind: "fnctor-shape",
    sourceId: admission.sourceId,
    constructorUnitId,
    constructorName: functionName,
    constructorTarget: irFnctorConstructorFuncRef(constructorUnitId, constructorName),
    reservedLayout: irFnctorLayoutTypeRef(constructorUnitId, structName),
    fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
    captures: [],
    userParamTypes: [{ kind: "string" }],
    hiddenIdentity,
    constructorIdentity: { unitId: constructorUnitId, paramIndex: 1 },
  };
}

function makeBoundedObservation(
  input: ObserveIrFnctorProducerInput,
  admission: IrFnctorAdmission,
): ProgramAbiFnctorObservation {
  const hiddenIdentity = !input.ctx.wasi;
  const constructorName = `${input.structName}_new`;
  const constructorTarget = irFnctorConstructorFuncRef(admission.constructorUnitId, constructorName);
  const reservedLayout = irFnctorLayoutTypeRef(admission.constructorUnitId, input.structName);
  return {
    shape: makeBoundedShape(admission, input.functionName, input.structName, constructorName, hiddenIdentity),
    sourceId: admission.sourceId,
    constructorUnitId: admission.constructorUnitId,
    reservedLayout,
    constructorFunc: constructorTarget,
    constructorFuncIdx: input.constructorFuncIdx,
    constructorFunction: input.constructorFunction,
    structTypeIdx: input.structTypeIdx,
    fields: input.fields,
    captureParamTypes: input.captureLayout.valueParamTypes,
    tdzFlagParamTypes: input.captureLayout.tdzFlagParamTypes,
    userParamTypes: input.userParamTypes,
    hiddenIdentity,
    constructorIdentityParamIndex: hiddenIdentity ? 1 : null,
    resultIsExternref: input.resultIsExternref,
  };
}

/**
 * Observe one exact approved `new F()` after its legacy constructor is built.
 * Returns true only when the Program-ABI sidecar received an observation;
 * absent planning context and unsupported physical layouts are no-ops.
 */
export function observeApprovedIrFnctor(input: ObserveIrFnctorProducerInput): boolean {
  const { ctx } = input;
  const registry = ctx.programAbiFnctors;
  const identityContext = ctx.irPlanningIdentityContext;
  if (!registry || !ctx.programAbiTypes || !identityContext) return false;
  if (!supportsBoundedPhysicalLane(input)) return false;

  const admission = makeIrFnctorAdmissionResolver(ctx, ctx.checker, identityContext)(input.site);
  if (
    !admission ||
    admission.constructorDeclaration !== input.declaration ||
    admission.constructorSite !== input.site
  ) {
    return false;
  }
  if (
    identityContext.sourceIdBySourceFile.get(input.site.getSourceFile()) !== admission.sourceId ||
    identityContext.unitIdByDeclaration.get(input.declaration) !== admission.constructorUnitId
  ) {
    return false;
  }
  const observation = makeBoundedObservation(input, admission);
  registry.observe(observation);
  return true;
}
