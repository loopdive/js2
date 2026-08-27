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
import { irTypeEquals, type IrFuncRef, type IrType, type IrTypeRef } from "../ir/nodes.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type { FieldDef, FuncHandle, FuncTypeDef, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { definedFuncAt } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE, planProgramAbiSupportCallable } from "./program-abi-planning.js";
import { canonicalProgramAbiTypeDef, canonicalProgramAbiValType } from "./program-abi-signatures.js";
import { fnctorConstructorField } from "./fnctor-identity-fields.js";
import { closureBagField } from "./closures/closure-header-layout.js";

export interface ProgramAbiFnctorObservation {
  readonly shape: IrFnctorShape;
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly reservedLayout: IrTypeRef;
  readonly constructorFunc: IrFuncRef;
  readonly constructorFuncIdx: FuncHandle;
  readonly constructorFunction: WasmFunction;
  readonly structTypeIdx: number;
  /** Complete physical reserved layout, including compiler-owned fields. */
  readonly fields: readonly FieldDef[];
  /** One exact logical-to-physical join for every user-visible shape field. */
  readonly fieldMappings: readonly ProgramAbiFnctorFieldMapping[];
  readonly captureParamTypes: readonly ValType[];
  readonly tdzFlagParamTypes: readonly ValType[];
  readonly userParamTypes: readonly ValType[];
  readonly hiddenIdentity: boolean;
  readonly constructorIdentityParamIndex: number | null;
  readonly resultIsExternref: boolean;
  readonly constructorResultType: ValType;
  readonly instanceCarrierType: ValType;
  readonly supportsConstruction: boolean;
  readonly supportsFieldGet: boolean;
}

export interface ProgramAbiFnctorFieldMapping {
  readonly name: string;
  readonly physicalIndex: number;
  readonly logicalType: IrType;
  readonly physicalType: ValType;
  readonly refinement: "none" | "nullable-native-string";
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

function exactFieldDefinition(actual: FieldDef, expected: FieldDef): boolean {
  return (
    actual.name === expected.name &&
    actual.mutable === expected.mutable &&
    physicalValTypeEqual(actual.type, expected.type) &&
    actual.presenceTracked !== true &&
    actual.dynamicObjectCarrier !== true &&
    actual.jsBoolean !== true &&
    actual.presenceBit === undefined
  );
}

function semanticTypeMatchesPhysicalInput(ctx: CodegenContext, logical: IrType, physical: ValType): boolean {
  if (logical.kind === "val") return physicalValTypeEqual(logical.val, physical);
  if (logical.kind !== "string") return false;
  if (!ctx.nativeStrings) return physical.kind === "externref";
  return physical.kind === "ref" && ctx.anyStrTypeIdx >= 0 && physical.typeIdx === ctx.anyStrTypeIdx;
}

function requireExactFieldMappings(
  ctx: CodegenContext,
  observation: ProgramAbiFnctorObservation,
  structType: StructTypeDef,
): void {
  if (observation.fieldMappings.length !== observation.shape.fields.length) {
    throw new Error("fnctor observation does not map every logical field exactly once");
  }
  const names = new Set<string>();
  const indices = new Set<number>();
  for (const logicalField of observation.shape.fields) {
    const mapping = observation.fieldMappings.find((candidate) => candidate.name === logicalField.name);
    if (!mapping || names.has(mapping.name) || indices.has(mapping.physicalIndex)) {
      throw new Error("fnctor observation field mapping is missing or duplicated");
    }
    if (
      !Number.isSafeInteger(mapping.physicalIndex) ||
      mapping.physicalIndex < 0 ||
      mapping.physicalIndex >= structType.fields.length ||
      mapping.physicalIndex !== logicalField.ordinal
    ) {
      throw new Error("fnctor observation field ordinal is not the exact physical layout index");
    }
    const physicalField = structType.fields[mapping.physicalIndex]!;
    if (
      physicalField.name !== logicalField.name ||
      mapping.name !== logicalField.name ||
      !irTypeEquals(mapping.logicalType, logicalField.type) ||
      !physicalValTypeEqual(mapping.physicalType, physicalField.type)
    ) {
      throw new Error("fnctor observation field mapping differs from the logical/physical layouts");
    }
    if (mapping.refinement === "nullable-native-string") {
      if (
        logicalField.type.kind !== "string" ||
        !ctx.nativeStrings ||
        ctx.anyStrTypeIdx < 0 ||
        physicalField.type.kind !== "ref_null" ||
        physicalField.type.typeIdx !== ctx.anyStrTypeIdx
      ) {
        throw new Error("fnctor observation has an invalid nullable native-string field refinement");
      }
    } else if (!semanticTypeMatchesPhysicalInput(ctx, logicalField.type, physicalField.type)) {
      throw new Error("fnctor observation field carrier needs an explicit exact refinement");
    }
    names.add(mapping.name);
    indices.add(mapping.physicalIndex);
  }
}

function requireExactCarrierContract(
  ctx: CodegenContext,
  observation: ProgramAbiFnctorObservation,
  structTypeIdx: number,
): void {
  const expectedConstructorResult: ValType = observation.resultIsExternref
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: structTypeIdx };
  if (!physicalValTypeEqual(observation.constructorResultType, expectedConstructorResult)) {
    throw new Error("fnctor observation constructor result carrier differs from its live ABI");
  }
  const instance = observation.instanceCarrierType;
  if (observation.resultIsExternref) {
    if (instance.kind !== "externref") {
      throw new Error("fnctor observation foreign result has a non-extern instance carrier");
    }
  } else if ((instance.kind !== "ref" && instance.kind !== "ref_null") || instance.typeIdx !== structTypeIdx) {
    throw new Error("fnctor observation instance carrier does not reference the reserved layout");
  }
  if (!observation.supportsConstruction && !observation.supportsFieldGet) {
    throw new Error("fnctor observation exposes no validated lowering capability");
  }
  if (observation.supportsConstruction) {
    if (
      observation.resultIsExternref ||
      observation.userParamTypes.length !== observation.shape.userParamTypes.length ||
      observation.userParamTypes.some(
        (physical, index) => !semanticTypeMatchesPhysicalInput(ctx, observation.shape.userParamTypes[index]!, physical),
      )
    ) {
      throw new Error("fnctor observation cannot authorize construction for its semantic/physical ABI");
    }
  }
  if (observation.supportsFieldGet && observation.fieldMappings.length !== observation.shape.fields.length) {
    throw new Error("fnctor observation cannot authorize field reads without complete mappings");
  }
}

function requireExactStandaloneParserLayout(ctx: CodegenContext, observation: ProgramAbiFnctorObservation): void {
  if (!ctx.standalone || ctx.wasi) return;
  const input = observation.fields[0];
  const constructorField = observation.fields[1];
  const bag = observation.fields[2];
  if (
    observation.fields.length !== 3 ||
    !input ||
    input.name !== "input" ||
    input.mutable !== true ||
    input.type.kind !== "ref_null" ||
    ctx.anyStrTypeIdx < 0 ||
    input.type.typeIdx !== ctx.anyStrTypeIdx ||
    !constructorField ||
    !exactFieldDefinition(constructorField, fnctorConstructorField()) ||
    !bag ||
    !exactFieldDefinition(bag, closureBagField())
  ) {
    throw new Error("fnctor standalone observation is not the exact input/$constructor/$bag layout");
  }
  if (
    observation.supportsConstruction ||
    !observation.supportsFieldGet ||
    observation.instanceCarrierType.kind !== "ref_null" ||
    observation.instanceCarrierType.typeIdx !== observation.structTypeIdx
  ) {
    throw new Error("fnctor standalone observation must be nullable/get-only");
  }
}

function expectedConstructorSignature(observation: ProgramAbiFnctorObservation, structTypeIdx: number): FuncTypeDef {
  const expectedResult: ValType = observation.resultIsExternref
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: structTypeIdx };
  return {
    kind: "func",
    params: [
      ...observation.captureParamTypes,
      ...observation.tdzFlagParamTypes,
      ...observation.userParamTypes,
      ...(observation.hiddenIdentity ? [{ kind: "externref" as const }] : []),
    ],
    results: [expectedResult],
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

/** Pure fail-closed validator for one logical-to-physical fnctor contract. */
export function validateProgramAbiFnctorPhysicalContract(
  ctx: CodegenContext,
  observation: ProgramAbiFnctorObservation,
): string | null {
  try {
    const shapeError = validateIrFnctorShape(observation.shape);
    if (shapeError) return shapeError;
    if (
      observation.sourceId !== observation.shape.sourceId ||
      observation.constructorUnitId !== observation.shape.constructorUnitId ||
      !exactSupportConstructorBinding(observation.shape) ||
      !exactSupportLayoutBinding(observation.shape) ||
      irCallableBindingKey(observation.constructorFunc.binding) !==
        irCallableBindingKey(observation.shape.constructorTarget.binding)
    ) {
      return "fnctor observation lacks the exact source/unit support constructor/layout bindings";
    }
    const structType = ctx.mod.types[observation.structTypeIdx];
    requireExactStructLayout(structType, observation);
    requireExactCarrierContract(ctx, observation, observation.structTypeIdx);
    requireExactStandaloneParserLayout(ctx, observation);
    requireExactFieldMappings(ctx, observation, structType);
    const expectedConstructorType = expectedConstructorSignature(observation, observation.structTypeIdx);
    const constructorType = ctx.mod.types[observation.constructorFunction.typeIdx];
    requireExactConstructorSignature(constructorType, expectedConstructorType, observation);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
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
    const physicalContractError = validateProgramAbiFnctorPhysicalContract(this.ctx, observation);
    if (physicalContractError) throw new Error(physicalContractError);
    if (!structType || structType.kind !== "struct") {
      throw new Error(`fnctor ${observation.shape.constructorName} does not own a live struct layout`);
    }
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
    const expectedIdentityIndex = observation.hiddenIdentity ? observation.shape.constructorIdentity.paramIndex : null;
    if (observation.constructorIdentityParamIndex !== expectedIdentityIndex) {
      throw new Error("fnctor observation identity parameter differs from the shape ABI");
    }
    const expectedConstructorType = expectedConstructorSignature(observation, observation.structTypeIdx);
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
    this.observations.set(
      key,
      Object.freeze({
        ...observation,
        fields: Object.freeze([...observation.fields]),
        fieldMappings: Object.freeze(observation.fieldMappings.map((mapping) => Object.freeze({ ...mapping }))),
      }),
    );
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
    const remapStructCarrier = (type: ValType): ValType =>
      type.kind === "ref" || type.kind === "ref_null" ? { ...type, typeIdx: currentStructTypeIdx } : type;
    const currentObservation: ProgramAbiFnctorObservation = {
      ...observation,
      structTypeIdx: currentStructTypeIdx,
      fields: currentStructType.fields,
      constructorResultType: remapStructCarrier(observation.constructorResultType),
      instanceCarrierType: remapStructCarrier(observation.instanceCarrierType),
      fieldMappings: observation.fieldMappings.map((mapping) => ({
        ...mapping,
        physicalType: currentStructType.fields[mapping.physicalIndex]?.type ?? mapping.physicalType,
      })),
    };
    try {
      requireExactCarrierContract(this.ctx, currentObservation, currentStructTypeIdx);
      requireExactStandaloneParserLayout(this.ctx, currentObservation);
      requireExactFieldMappings(this.ctx, currentObservation, currentStructType);
    } catch {
      return null;
    }
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
    const fieldMappings = new Map(observation.fieldMappings.map((mapping) => [mapping.name, mapping] as const));
    return {
      instanceCarrierType: currentObservation.instanceCarrierType,
      constructorResultType: expectedResult,
      reservedLayout: observation.reservedLayout,
      constructorFunc: observation.constructorFunc,
      captureParamTypes: constructorType.params.slice(0, captureCount),
      tdzFlagParamTypes: constructorType.params.slice(captureCount, captureCount + tdzCount),
      userParamTypes: constructorType.params.slice(captureCount + tdzCount, captureCount + tdzCount + userCount),
      hiddenIdentity: observation.hiddenIdentity,
      constructorIdentityParamIndex: observation.constructorIdentityParamIndex,
      resultIsExternref: observation.resultIsExternref,
      supportsConstruction: observation.supportsConstruction,
      supportsFieldGet: observation.supportsFieldGet,
      structTypeIdx: currentStructTypeIdx,
      field(name: string) {
        const mapping = fieldMappings.get(name);
        if (mapping === undefined) throw new Error(`unknown resolved fnctor field ${name}`);
        const physicalField = currentStructType.fields[mapping.physicalIndex];
        if (!physicalField) throw new Error(`missing resolved fnctor field ${name}`);
        return {
          fieldIdx: mapping.physicalIndex,
          logicalType: mapping.logicalType,
          physicalType: physicalField.type,
          refinement: mapping.refinement,
        };
      },
      fieldIdx(name: string): number {
        const mapping = fieldMappings.get(name);
        if (mapping === undefined) throw new Error(`unknown resolved fnctor field ${name}`);
        return mapping.physicalIndex;
      },
    };
  }

  has(sourceId: IrSourceId, constructorUnitId: IrUnitId): boolean {
    return this.observations.has(observationKey(sourceId, constructorUnitId));
  }
}
