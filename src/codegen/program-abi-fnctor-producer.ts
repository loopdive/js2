// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The bounded AST producer for the Program-ABI fnctor sidecar.
 *
 * This module records no IR instruction and does not alter the legacy
 * constructor body or call site.  It only observes a constructor after the
 * existing AST compiler has built its reserved struct/function pair.  The
 * The host lane observes one unconditional `input: string` field with no
 * captures/TDZ cells. The bounded standalone lane observes only the exact
 * post-legacy `input/$constructor/$bag` layout certified by the shared
 * logical-to-physical contract; unsupported layouts remain legacy-owned.
 */

import { irFnctorLayoutTypeRef } from "../ir/abi-bindings.js";
import { irFnctorConstructorFuncRef } from "../ir/callable-bindings.js";
import { validateIrFnctorShape, type IrFnctorShape } from "../ir/fnctor-abi.js";
import type { IrFnctorAdmission } from "../ir/propagate.js";
import type { FieldDef, FuncHandle, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { makeIrFnctorAdmissionResolver, makeIrFnctorArgumentProjectionAuthority } from "./ir-fnctor-admission.js";
import type { FnctorCaptureLayout } from "./fnctor-constructor-identity.js";
import type { ProgramAbiFnctorObservation } from "./program-abi-fnctor-planning.js";
import { canonicalProgramAbiValType } from "./program-abi-signatures.js";
import { fnctorConstructorField } from "./fnctor-identity-fields.js";
import { closureBagField } from "./closures/closure-header-layout.js";
import { proveIrFnctorInputConstructorSyntax } from "../ir/fnctor-argument-projection.js";
import { ts } from "../ts-api.js";

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

export interface StandaloneIrFnctorShapeInput {
  readonly sourceId: import("../ir/identity.js").IrSourceId;
  readonly constructorUnitId: import("../ir/identity.js").IrUnitId;
  /** Diagnostic source label only; identity comes from sourceId/unitId. */
  readonly constructorName: string;
  readonly reservedLayoutName: string;
}

/**
 * Build the one nominal shape shared by standalone observation and its later
 * preselection consumer. Keeping this construction single-sourced prevents a
 * selector plan from silently describing a different support binding/layout
 * than the post-legacy observation it resolves.
 */
export function buildStandaloneIrFnctorShape(input: StandaloneIrFnctorShapeInput): IrFnctorShape {
  return {
    kind: "fnctor-shape",
    sourceId: input.sourceId,
    constructorUnitId: input.constructorUnitId,
    constructorName: input.constructorName,
    constructorTarget: irFnctorConstructorFuncRef(input.constructorUnitId, `${input.reservedLayoutName}_new`),
    reservedLayout: irFnctorLayoutTypeRef(input.constructorUnitId, input.reservedLayoutName),
    fields: [{ name: "input", type: { kind: "string" }, ordinal: 0 }],
    captures: [],
    userParamTypes: [{ kind: "string" }],
    hiddenIdentity: true,
    constructorIdentity: { unitId: input.constructorUnitId, paramIndex: 1 },
  };
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
  const shape = makeBoundedShape(admission, input.functionName, input.structName, constructorName, hiddenIdentity);
  const constructorResultType = input.resultIsExternref
    ? ({ kind: "externref" } as const)
    : ({ kind: "ref", typeIdx: input.structTypeIdx } as const);
  return {
    shape,
    sourceId: admission.sourceId,
    constructorUnitId: admission.constructorUnitId,
    reservedLayout,
    constructorFunc: constructorTarget,
    constructorFuncIdx: input.constructorFuncIdx,
    constructorFunction: input.constructorFunction,
    structTypeIdx: input.structTypeIdx,
    fields: input.fields,
    fieldMappings: [
      {
        name: "input",
        physicalIndex: shape.fields[0]!.ordinal,
        logicalType: shape.fields[0]!.type,
        physicalType: input.fields[0]!.type,
        refinement: "none",
      },
    ],
    captureParamTypes: input.captureLayout.valueParamTypes,
    tdzFlagParamTypes: input.captureLayout.tdzFlagParamTypes,
    userParamTypes: input.userParamTypes,
    hiddenIdentity,
    constructorIdentityParamIndex: hiddenIdentity ? 1 : null,
    resultIsExternref: input.resultIsExternref,
    constructorResultType,
    instanceCarrierType: constructorResultType,
    supportsConstruction: !input.resultIsExternref,
    supportsFieldGet: !input.resultIsExternref,
  };
}

function exactField(actual: FieldDef | undefined, expected: FieldDef): boolean {
  return (
    actual !== undefined &&
    actual.name === expected.name &&
    actual.mutable === expected.mutable &&
    canonicalProgramAbiValType(actual.type) === canonicalProgramAbiValType(expected.type) &&
    actual.presenceTracked !== true &&
    actual.dynamicObjectCarrier !== true &&
    actual.jsBoolean !== true &&
    actual.presenceBit === undefined
  );
}

/**
 * Build the exact get-only standalone observation used by the late #3521
 * overlay. This is intentionally pure with respect to ProgramAbiSession: L2
 * tests the physical contract without enabling the AST producer.
 */
export function buildStandaloneIrFnctorObservation(
  input: ObserveIrFnctorProducerInput,
  shape: IrFnctorShape,
): ProgramAbiFnctorObservation | undefined {
  const { ctx } = input;
  if (
    !ctx.standalone ||
    ctx.wasi ||
    !ctx.nativeStrings ||
    ctx.fast ||
    input.resultIsExternref ||
    validateIrFnctorShape(shape) !== null ||
    shape.sourceId !== ctx.irPlanningIdentityContext?.sourceIdBySourceFile.get(input.declaration.getSourceFile()) ||
    shape.constructorUnitId !== ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(input.declaration) ||
    shape.constructorUnitId !== shape.constructorIdentity.unitId ||
    shape.constructorIdentity.paramIndex !== 1 ||
    shape.hiddenIdentity !== true ||
    shape.captures.length !== 0 ||
    shape.userParamTypes.length !== 1 ||
    shape.userParamTypes[0]?.kind !== "string" ||
    shape.fields.length !== 1 ||
    shape.fields[0]?.name !== "input" ||
    shape.fields[0]?.ordinal !== 0 ||
    shape.fields[0]?.type.kind !== "string" ||
    input.captureLayout.captures.length !== 0 ||
    input.captureLayout.valueParamTypes.length !== 0 ||
    input.captureLayout.tdzFlagParamTypes.length !== 0 ||
    input.userParamTypes.length !== 1 ||
    input.userParamTypes[0]?.kind !== "externref" ||
    ctx.anyStrTypeIdx < 0 ||
    ctx.fnctorReservedTypeIdx.get(input.functionName) !== input.structTypeIdx ||
    ctx.structMap.get(input.structName) !== input.structTypeIdx ||
    ctx.fnctorLayoutInfo?.has(input.structName) ||
    ctx.fnctorColdTailStructName?.has(input.structName)
  ) {
    return undefined;
  }
  const inputField = input.fields[0];
  if (
    input.fields.length !== 3 ||
    !inputField ||
    inputField.name !== "input" ||
    inputField.mutable !== true ||
    inputField.type.kind !== "ref_null" ||
    inputField.type.typeIdx !== ctx.anyStrTypeIdx ||
    inputField.presenceTracked === true ||
    inputField.dynamicObjectCarrier === true ||
    inputField.jsBoolean === true ||
    inputField.presenceBit !== undefined ||
    !exactField(input.fields[1], fnctorConstructorField()) ||
    !exactField(input.fields[2], closureBagField())
  ) {
    return undefined;
  }
  const constructorResultType = { kind: "ref" as const, typeIdx: input.structTypeIdx };
  return {
    shape,
    sourceId: shape.sourceId,
    constructorUnitId: shape.constructorUnitId,
    reservedLayout: shape.reservedLayout,
    constructorFunc: shape.constructorTarget,
    constructorFuncIdx: input.constructorFuncIdx,
    constructorFunction: input.constructorFunction,
    structTypeIdx: input.structTypeIdx,
    fields: input.fields,
    fieldMappings: [
      {
        name: "input",
        physicalIndex: 0,
        logicalType: { kind: "string" },
        physicalType: inputField.type,
        refinement: "nullable-native-string",
      },
    ],
    captureParamTypes: [],
    tdzFlagParamTypes: [],
    userParamTypes: input.userParamTypes,
    hiddenIdentity: true,
    constructorIdentityParamIndex: 1,
    resultIsExternref: false,
    constructorResultType,
    instanceCarrierType: { kind: "ref_null", typeIdx: input.structTypeIdx },
    supportsConstruction: false,
    supportsFieldGet: true,
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

  if (
    ctx.standalone &&
    !ctx.wasi &&
    ctx.nativeStrings &&
    !ctx.fast &&
    ctx.targetProfile.semanticProviders === "native-first"
  ) {
    const syntax = proveIrFnctorInputConstructorSyntax(ctx.checker, identityContext, input.declaration);
    const argument = input.site.arguments?.[0];
    const reservation = syntax
      ? makeIrFnctorArgumentProjectionAuthority(ctx, ctx.checker).resolvePhysicalReservation(input.site, syntax)
      : undefined;
    if (
      !syntax ||
      syntax.constructorDeclaration !== input.declaration ||
      syntax.sourceFile !== input.site.getSourceFile() ||
      syntax.constructorUnitId !== identityContext.unitIdByDeclaration.get(input.declaration) ||
      !reservation ||
      reservation.reservationKey !== input.structName ||
      reservation.reservedTypeIdx !== input.structTypeIdx ||
      input.site.arguments?.length !== 1 ||
      !argument ||
      !ts.isStringLiteralLike(argument)
    ) {
      return false;
    }
    const shape = buildStandaloneIrFnctorShape({
      sourceId: syntax.sourceId,
      constructorUnitId: syntax.constructorUnitId,
      constructorName: input.functionName,
      reservedLayoutName: input.structName,
    });
    const observation = buildStandaloneIrFnctorObservation(input, shape);
    if (!observation) return false;
    registry.observe(observation);
    return true;
  }

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
