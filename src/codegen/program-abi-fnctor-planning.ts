// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Source/unit-qualified sidecar for synthesized function-style constructors.
 *
 * The legacy constructor maps are intentionally name-keyed and therefore are
 * not a resolver authority. This registry is an additive observation seam:
 * until the AST producer records an exact support binding, `resolve()` returns
 * null and the IR lowerer remains fail-closed.
 */

import { irCallableBindingKey, irFnctorConstructorBindingId } from "../ir/callable-bindings.js";
import { irFnctorLayoutTypeRef, irTypeBindingKey } from "../ir/abi-bindings.js";
import { irFnctorShapeEquals, validateIrFnctorShape, type IrFnctorShape } from "../ir/fnctor-abi.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { ProgramAbiSession } from "./program-abi-session.js";
import type { CodegenContext } from "./context/types.js";
import type { IrFnctorLowering } from "../ir/backend/handles.js";
import type { IrFuncRef, IrTypeRef } from "../ir/nodes.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type { FieldDef, FuncHandle, FuncTypeDef, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { definedFuncAt } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE, planProgramAbiSupportCallable } from "./program-abi-planning.js";
import { canonicalProgramAbiTypeDef, canonicalProgramAbiValType } from "./program-abi-signatures.js";

export interface ProgramAbiFnctorObservation {
  readonly shape: IrFnctorShape;
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly reservedLayout: IrTypeRef;
  readonly constructorFunc: IrFuncRef;
  readonly constructorFuncIdx: FuncHandle;
  readonly constructorFunction: WasmFunction;
  readonly structTypeIdx: number;
  readonly fields: readonly FieldDef[];
  readonly captureParamTypes: readonly ValType[];
  readonly tdzFlagParamTypes: readonly ValType[];
  readonly userParamTypes: readonly ValType[];
  readonly hiddenIdentity: boolean;
  readonly constructorIdentityParamIndex: number | null;
  readonly resultIsExternref: boolean;
}

function observationKey(sourceId: IrSourceId, unitId: IrUnitId): string {
  return `${sourceId.length}:${sourceId}${unitId.length}:${unitId}`;
}

function exactSupportConstructorBinding(shape: IrFnctorShape): boolean {
  return (
    shape.constructorTarget.binding.kind === "support" &&
    shape.constructorTarget.binding.bindingId === irFnctorConstructorBindingId(shape.constructorUnitId)
  );
}

function exactSupportLayoutBinding(shape: IrFnctorShape): boolean {
  return (
    shape.reservedLayout.binding.kind === "support" &&
    shape.reservedLayout.binding.bindingId ===
      irFnctorLayoutTypeRef(shape.constructorUnitId, shape.reservedLayout.name).binding.bindingId
  );
}

function physicalValTypeEqual(left: ValType, right: ValType): boolean {
  return canonicalProgramAbiValType(left) === canonicalProgramAbiValType(right);
}

function expectedConstructorSignature(observation: ProgramAbiFnctorObservation, structTypeIdx: number): FuncTypeDef {
  return {
    kind: "func",
    params: [
      ...observation.captureParamTypes,
      ...observation.tdzFlagParamTypes,
      ...observation.userParamTypes,
      ...(observation.hiddenIdentity ? [{ kind: "externref" as const }] : []),
    ],
    results: observation.resultIsExternref
      ? [{ kind: "externref" as const }]
      : [{ kind: "ref" as const, typeIdx: structTypeIdx }],
  };
}

function requireExactStructLayout(
  actual: unknown,
  observation: ProgramAbiFnctorObservation,
): asserts actual is StructTypeDef {
  if (!actual || typeof actual !== "object" || (actual as { kind?: unknown }).kind !== "struct") {
    throw new Error(`fnctor ${observation.shape.constructorName} does not own a live struct layout`);
  }
  const structType = actual as StructTypeDef;
  if (structType.superTypeIdx !== undefined || structType.final !== undefined) {
    throw new Error(`fnctor ${observation.shape.constructorName} layout must be a non-subtype reserved struct`);
  }
  const expected: StructTypeDef = {
    kind: "struct",
    name: structType.name,
    fields: [...observation.fields],
  };
  if (canonicalProgramAbiTypeDef(structType) !== canonicalProgramAbiTypeDef(expected)) {
    throw new Error(`fnctor ${observation.shape.constructorName} physical struct layout differs from its ABI shape`);
  }
}

function requireExactConstructorSignature(
  actual: unknown,
  expected: FuncTypeDef,
  observation: ProgramAbiFnctorObservation,
): asserts actual is FuncTypeDef {
  if (!actual || typeof actual !== "object" || (actual as { kind?: unknown }).kind !== "func") {
    throw new Error(`fnctor ${observation.shape.constructorName} constructor has no live function signature`);
  }
  const signature = actual as FuncTypeDef;
  if (
    signature.params.length !== expected.params.length ||
    signature.results.length !== expected.results.length ||
    signature.params.some((type, index) => !physicalValTypeEqual(type, expected.params[index]!)) ||
    signature.results.some((type, index) => !physicalValTypeEqual(type, expected.results[index]!))
  ) {
    throw new Error(
      `fnctor ${observation.shape.constructorName} physical constructor signature differs from its ABI shape`,
    );
  }
}

/** One immutable ABI observation per exact source/unit constructor. */
export class ProgramAbiFnctorRegistry {
  private readonly observations = new Map<string, ProgramAbiFnctorObservation>();

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
    readonly identityContext: IrPlanningIdentityContext,
  ) {
    session.assertModule(ctx.mod);
    if (identityContext.inventory !== session.inventory) {
      throw new Error("Program ABI fnctor registry and planning context do not share one inventory");
    }
  }

  observe(observation: ProgramAbiFnctorObservation): void {
    const shapeError = validateIrFnctorShape(observation.shape);
    if (shapeError) throw new Error(`invalid fnctor observation: ${shapeError}`);
    if (
      observation.sourceId !== observation.shape.sourceId ||
      observation.constructorUnitId !== observation.shape.constructorUnitId ||
      !exactSupportConstructorBinding(observation.shape) ||
      !exactSupportLayoutBinding(observation.shape)
    ) {
      throw new Error("fnctor observation lacks the exact source/unit support constructor/layout bindings");
    }
    const sourceFile = this.identityContext.sourceFileBySourceId.get(observation.sourceId);
    const unit = this.identityContext.unitByUnitId.get(observation.constructorUnitId);
    if (!sourceFile || !unit || unit.sourceId !== observation.sourceId) {
      throw new Error("fnctor observation has no exact planning identity");
    }
    if (observation.constructorIdentityParamIndex !== null && !observation.hiddenIdentity) {
      throw new Error("fnctor observation carries an identity index without hidden identity");
    }
    if (observation.hiddenIdentity !== observation.shape.hiddenIdentity) {
      throw new Error("fnctor observation hidden-identity mode differs from the shape");
    }
    if (observation.hiddenIdentity !== !this.ctx.wasi) {
      throw new Error("fnctor observation hidden-identity mode differs from the active ABI lane");
    }
    if (observation.resultIsExternref && !(this.ctx.standalone || this.ctx.wasi)) {
      throw new Error("fnctor observation requests a foreign result outside the standalone/WASI ABI lane");
    }
    if (
      irCallableBindingKey(observation.constructorFunc.binding) !==
      irCallableBindingKey(observation.shape.constructorTarget.binding)
    ) {
      throw new Error("fnctor observation constructor object is not the exact shape target");
    }
    if (!Number.isSafeInteger(observation.constructorFuncIdx) || observation.constructorFuncIdx < 0) {
      throw new Error("fnctor observation has an invalid constructor function handle");
    }
    if (definedFuncAt(this.ctx, observation.constructorFuncIdx) !== observation.constructorFunction) {
      throw new Error("fnctor observation constructor handle is not the live function object");
    }
    if (observation.constructorFunction.name !== `${observation.shape.reservedLayout.name}_new`) {
      throw new Error("fnctor observation constructor function has the wrong reserved-layout provenance");
    }
    if (observation.structTypeIdx < 0 || !Number.isSafeInteger(observation.structTypeIdx)) {
      throw new Error("fnctor observation has an invalid struct type index");
    }
    const structType = this.ctx.mod.types[observation.structTypeIdx];
    requireExactStructLayout(structType, observation);
    if (
      observation.captureParamTypes.length !== observation.shape.captures.length ||
      observation.tdzFlagParamTypes.length !==
        observation.shape.captures.filter((capture) => capture.hasTdzFlag).length ||
      observation.userParamTypes.length !== observation.shape.userParamTypes.length
    ) {
      throw new Error("fnctor observation physical constructor ABI arity differs from the shape");
    }
    if (observation.tdzFlagParamTypes.some((type) => type.kind !== "i32")) {
      throw new Error("fnctor observation TDZ flags must use the i32 ABI type");
    }
    if (observation.fields.length !== observation.shape.fields.length) {
      throw new Error("fnctor observation field layout differs from the shape");
    }
    for (let index = 0; index < observation.fields.length; index++) {
      if (observation.fields[index]!.name !== observation.shape.fields[index]!.name) {
        throw new Error("fnctor observation field names/order differ from the shape");
      }
    }
    const expectedIdentityIndex = observation.hiddenIdentity ? observation.shape.constructorIdentity.paramIndex : null;
    if (observation.constructorIdentityParamIndex !== expectedIdentityIndex) {
      throw new Error("fnctor observation identity parameter differs from the shape ABI");
    }
    const expectedConstructorType = expectedConstructorSignature(observation, observation.structTypeIdx);
    const constructorType = this.ctx.mod.types[observation.constructorFunction.typeIdx];
    requireExactConstructorSignature(constructorType, expectedConstructorType, observation);
    const key = observationKey(observation.sourceId, observation.constructorUnitId);
    const prior = this.observations.get(key);
    if (prior && !irFnctorShapeEquals(prior.shape, observation.shape)) {
      throw new Error("fnctor source/unit has conflicting ABI observations");
    }
    if (prior && prior.constructorFunction !== observation.constructorFunction) {
      throw new Error("fnctor source/unit changed synthesized constructor object");
    }
    const plannedConstructor = planProgramAbiSupportCallable(this.ctx, {
      ref: observation.constructorFunc,
      anchor: { kind: "unit", unitId: observation.constructorUnitId },
      role: "fnctor-constructor",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.fnctorConstructor,
      signature: expectedConstructorType,
      func: observation.constructorFunction,
    });
    if (plannedConstructor !== irFnctorConstructorBindingId(observation.constructorUnitId)) {
      throw new Error("fnctor constructor observation did not produce its exact Program ABI support plan");
    }
    const typeRegistry = this.ctx.programAbiTypes;
    if (!typeRegistry) throw new Error("fnctor observation requires the Program ABI type registry");
    typeRegistry.prepareFnctorLayoutType(observation.constructorUnitId, observation.shape.reservedLayout, structType);
    this.observations.set(key, Object.freeze({ ...observation, fields: Object.freeze([...observation.fields]) }));
  }

  resolve(shape: IrFnctorShape): IrFnctorLowering | null {
    if (validateIrFnctorShape(shape) !== null || !exactSupportConstructorBinding(shape)) return null;
    const observation = this.observations.get(observationKey(shape.sourceId, shape.constructorUnitId));
    if (!observation || !irFnctorShapeEquals(observation.shape, shape)) return null;
    const layoutBindingId = observation.shape.reservedLayout.binding.bindingId;
    const layoutKey = irTypeBindingKey(observation.shape.reservedLayout.binding);
    const currentStructTypeIdx = this.session.resolveCurrentIndex(layoutBindingId, "type", layoutKey, this.ctx.mod);
    const currentStructType = this.ctx.mod.types[currentStructTypeIdx];
    if (!currentStructType || currentStructType.kind !== "struct") return null;
    const constructorType = this.ctx.mod.types[observation.constructorFunction.typeIdx];
    if (!constructorType || constructorType.kind !== "func") return null;
    const captureCount = observation.captureParamTypes.length;
    const tdzCount = observation.tdzFlagParamTypes.length;
    const userCount = observation.userParamTypes.length;
    const expectedParamCount = captureCount + tdzCount + userCount + (observation.hiddenIdentity ? 1 : 0);
    if (
      constructorType.params.length !== expectedParamCount ||
      constructorType.params.slice(captureCount, captureCount + tdzCount).some((type) => type.kind !== "i32")
    ) {
      return null;
    }
    const expectedResult = observation.resultIsExternref
      ? { kind: "externref" as const }
      : { kind: "ref" as const, typeIdx: currentStructTypeIdx };
    if (
      constructorType.results.length !== 1 ||
      !physicalValTypeEqual(constructorType.results[0]!, expectedResult) ||
      (observation.hiddenIdentity && constructorType.params.at(-1)?.kind !== "externref")
    ) {
      return null;
    }
    const fieldIndices = new Map(observation.fields.map((field, index) => [field.name, index] as const));
    return {
      carrierType: observation.resultIsExternref
        ? { kind: "externref" }
        : { kind: "ref", typeIdx: currentStructTypeIdx },
      reservedLayout: observation.reservedLayout,
      constructorFunc: observation.constructorFunc,
      captureParamTypes: constructorType.params.slice(0, captureCount),
      tdzFlagParamTypes: constructorType.params.slice(captureCount, captureCount + tdzCount),
      userParamTypes: constructorType.params.slice(captureCount + tdzCount, captureCount + tdzCount + userCount),
      hiddenIdentity: observation.hiddenIdentity,
      constructorIdentityParamIndex: observation.constructorIdentityParamIndex,
      resultIsExternref: observation.resultIsExternref,
      structTypeIdx: currentStructTypeIdx,
      fieldIdx(name: string): number {
        const index = fieldIndices.get(name);
        if (index === undefined) throw new Error(`unknown resolved fnctor field ${name}`);
        return index;
      },
    };
  }

  has(sourceId: IrSourceId, constructorUnitId: IrUnitId): boolean {
    return this.observations.has(observationKey(sourceId, constructorUnitId));
  }
}
