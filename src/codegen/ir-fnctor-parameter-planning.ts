// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Exact preselection authority for the bounded #3521 linked fnctor parameter.
 *
 * The retained argument edge alone is syntax evidence. This module joins that
 * edge to the post-legacy fnctor observation and the current source-callable
 * slot before selection can reinterpret the unannotated parameter. No caller
 * is selected here; an absent or stale join returns undefined.
 */

import { irCallableBindingKey } from "../ir/callable-bindings.js";
import { irTypeBindingKey } from "../ir/abi-bindings.js";
import {
  retainIrFnctorArgumentProjections,
  type IrFnctorArgumentProjection,
  type IrFnctorArgumentProjectionAuthority,
} from "../ir/fnctor-argument-projection.js";
import { irFnctorShapeEquals, type IrFnctorShape } from "../ir/fnctor-abi.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { irFnctor, type IrType } from "../ir/nodes.js";
import type { FuncHandle, FuncTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import {
  irFnctorArgumentProjectionRouteIsActive,
  type IrFnctorArgumentProjectionRoute,
} from "./ir-fnctor-admission.js";
import { buildStandaloneIrFnctorShape } from "./program-abi-fnctor-producer.js";
import { canonicalProgramAbiValType, cloneProgramAbiValType } from "./program-abi-signatures.js";

export interface IrFnctorFieldReadPlan {
  readonly access: ts.PropertyAccessExpression;
  readonly fieldName: "input";
}

export interface IrFnctorParameterPreselectionPlan {
  readonly kind: "fnctor-parameter-preselection";
  readonly projection: IrFnctorArgumentProjection;
  readonly shape: IrFnctorShape;
  readonly selectorKind: "object";
  readonly overrideType: IrType;
  readonly ownerUnitId: IrFnctorArgumentProjection["calleeUnitId"];
  readonly parameterDeclaration: ts.ParameterDeclaration;
  readonly parameterIndex: 0;
  readonly fieldReads: readonly IrFnctorFieldReadPlan[];
  /** Exact `.slice(0, parser.input.length)` call fed to the parser callee. */
  readonly stringSliceCall: ts.CallExpression;
  /** Exact direct consumer of the slice value; target identity is joined by the signature plan. */
  readonly valueConsumerCall: ts.CallExpression;
  readonly physical: {
    readonly instanceCarrier: ValType;
    readonly fieldCarrier: ValType;
    readonly fieldIndex: number;
    readonly fieldRefinement: "nullable-native-string";
  };
  readonly preselection: {
    readonly handle: FuncHandle;
    readonly func: WasmFunction;
    readonly typeIdx: number;
    readonly type: FuncTypeDef;
  };
}

export interface PlanIrFnctorParameterPreselectionInput {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly identityContext: IrPlanningIdentityContext;
  readonly route: IrFnctorArgumentProjectionRoute;
  readonly authority: IrFnctorArgumentProjectionAuthority;
  readonly projections: readonly IrFnctorArgumentProjection[] | undefined;
}

interface ExactFieldReadTopology {
  readonly fieldReads: readonly IrFnctorFieldReadPlan[];
  readonly stringSliceCall: ts.CallExpression;
  readonly valueConsumerCall: ts.CallExpression;
}

function sameValType(left: ValType, right: ValType): boolean {
  return canonicalProgramAbiValType(left) === canonicalProgramAbiValType(right);
}

function symbolOwnsParameter(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  parameter: ts.ParameterDeclaration,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return (
    symbol !== undefined &&
    (symbol.valueDeclaration === parameter || (symbol.declarations?.includes(parameter) ?? false))
  );
}

function exactFieldReadTopology(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
): ExactFieldReadTopology | undefined {
  if (!declaration.body || !ts.isIdentifier(parameter.name)) return undefined;
  const accesses: ts.PropertyAccessExpression[] = [];
  let invalidUse = false;
  const visit = (node: ts.Node): void => {
    if (invalidUse) return;
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && symbolOwnsParameter(checker, node, parameter)) {
      const access = node.parent;
      if (
        !ts.isPropertyAccessExpression(access) ||
        access.expression !== node ||
        access.questionDotToken !== undefined ||
        access.name.text !== "input"
      ) {
        invalidUse = true;
        return;
      }
      accesses.push(access);
      return;
    }
    forEachChild(node, visit);
  };
  visit(declaration.body);
  if (invalidUse || accesses.length !== 2 || accesses[0] === accesses[1]) return undefined;

  const sliceInput = accesses.find(
    (access) =>
      ts.isPropertyAccessExpression(access.parent) &&
      access.parent.expression === access &&
      access.parent.questionDotToken === undefined &&
      access.parent.name.text === "slice",
  );
  const lengthInput = accesses.find(
    (access) =>
      ts.isPropertyAccessExpression(access.parent) &&
      access.parent.expression === access &&
      access.parent.questionDotToken === undefined &&
      access.parent.name.text === "length",
  );
  if (!sliceInput || !lengthInput || sliceInput === lengthInput) return undefined;
  const sliceMember = sliceInput.parent as ts.PropertyAccessExpression;
  const lengthMember = lengthInput.parent as ts.PropertyAccessExpression;
  const sliceCall = sliceMember.parent;
  if (
    !ts.isCallExpression(sliceCall) ||
    sliceCall.expression !== sliceMember ||
    sliceCall.questionDotToken !== undefined ||
    (sliceCall.typeArguments?.length ?? 0) !== 0 ||
    sliceCall.arguments.length !== 2 ||
    !ts.isNumericLiteral(sliceCall.arguments[0]) ||
    Number(sliceCall.arguments[0].text) !== 0 ||
    sliceCall.arguments[1] !== lengthMember ||
    sliceCall.arguments.some(ts.isSpreadElement)
  ) {
    return undefined;
  }
  const consumer = sliceCall.parent;
  if (
    !ts.isCallExpression(consumer) ||
    !ts.isIdentifier(consumer.expression) ||
    consumer.questionDotToken !== undefined ||
    (consumer.typeArguments?.length ?? 0) !== 0 ||
    consumer.arguments.length !== 2 ||
    consumer.arguments[0] !== sliceCall ||
    consumer.arguments.some(ts.isSpreadElement) ||
    !ts.isReturnStatement(consumer.parent) ||
    consumer.parent.expression !== consumer
  ) {
    return undefined;
  }
  const fieldReads = Object.freeze(
    accesses
      .slice()
      .sort((left, right) => left.getStart() - right.getStart())
      .map((access) => Object.freeze({ access, fieldName: "input" as const })),
  );
  return { fieldReads, stringSliceCall: sliceCall, valueConsumerCall: consumer };
}

function exactResolvedPhysicalContract(
  ctx: CodegenContext,
  shape: IrFnctorShape,
  projection: IrFnctorArgumentProjection,
):
  | {
      readonly instanceCarrier: ValType;
      readonly fieldCarrier: ValType;
      readonly fieldIndex: number;
      readonly fieldRefinement: "nullable-native-string";
    }
  | undefined {
  const registry = ctx.programAbiFnctors;
  if (registry?.ctx !== ctx || registry.identityContext !== ctx.irPlanningIdentityContext) return undefined;
  const lowering = registry.resolve(shape);
  if (
    !lowering ||
    lowering.supportsConstruction ||
    !lowering.supportsFieldGet ||
    lowering.resultIsExternref ||
    !lowering.hiddenIdentity ||
    lowering.constructorIdentityParamIndex !== 1 ||
    lowering.captureParamTypes.length !== 0 ||
    lowering.tdzFlagParamTypes.length !== 0 ||
    lowering.userParamTypes.length !== 1 ||
    lowering.userParamTypes[0]?.kind !== "externref" ||
    lowering.structTypeIdx === undefined ||
    lowering.structTypeIdx !== projection.physicalReservation.reservedTypeIdx ||
    lowering.instanceCarrierType.kind !== "ref_null" ||
    lowering.instanceCarrierType.typeIdx !== lowering.structTypeIdx ||
    lowering.constructorResultType.kind !== "ref" ||
    lowering.constructorResultType.typeIdx !== lowering.structTypeIdx ||
    irTypeBindingKey(lowering.reservedLayout.binding) !== irTypeBindingKey(shape.reservedLayout.binding) ||
    irCallableBindingKey(lowering.constructorFunc.binding) !== irCallableBindingKey(shape.constructorTarget.binding)
  ) {
    return undefined;
  }
  let field;
  try {
    field = lowering.field("input");
    if (lowering.fieldIdx("input") !== field.fieldIdx) return undefined;
  } catch {
    return undefined;
  }
  if (
    field.fieldIdx !== 0 ||
    field.logicalType.kind !== "string" ||
    field.physicalType.kind !== "ref_null" ||
    ctx.anyStrTypeIdx < 0 ||
    field.physicalType.typeIdx !== ctx.anyStrTypeIdx ||
    field.refinement !== "nullable-native-string"
  ) {
    return undefined;
  }
  return Object.freeze({
    instanceCarrier: cloneProgramAbiValType(lowering.instanceCarrierType),
    fieldCarrier: cloneProgramAbiValType(field.physicalType),
    fieldIndex: field.fieldIdx,
    fieldRefinement: field.refinement,
  });
}

function exactSourceCallable(
  ctx: CodegenContext,
  ownerUnitId: IrFnctorArgumentProjection["calleeUnitId"],
  physicalCarrier: ValType,
): IrFnctorParameterPreselectionPlan["preselection"] | undefined {
  const registry = ctx.programAbiSourceCallables;
  if (registry?.ctx !== ctx || registry.identityContext !== ctx.irPlanningIdentityContext) return undefined;
  const handle = registry.handleForUnit(ownerUnitId);
  const func = registry.functionForUnit(ownerUnitId);
  if (
    handle === undefined ||
    !Number.isSafeInteger(handle) ||
    handle < 0 ||
    !func ||
    definedFuncAt(ctx, handle) !== func
  ) {
    return undefined;
  }
  const typeIdx = func.typeIdx;
  const type = Number.isSafeInteger(typeIdx) && typeIdx >= 0 ? ctx.mod.types[typeIdx] : undefined;
  if (
    !type ||
    type.kind !== "func" ||
    ctx.mod.types[typeIdx] !== type ||
    type.params.length !== 1 ||
    !sameValType(type.params[0]!, physicalCarrier) ||
    type.results.length !== 1 ||
    type.results[0]?.kind !== "f64"
  ) {
    return undefined;
  }
  return Object.freeze({ handle, func, typeIdx, type });
}

function buildCurrentShape(projection: IrFnctorArgumentProjection): IrFnctorShape | undefined {
  const name = projection.constructorDeclaration.name;
  if (!name || !ts.isIdentifier(name) || name.text.length === 0) return undefined;
  return buildStandaloneIrFnctorShape({
    sourceId: projection.sourceId,
    constructorUnitId: projection.constructorUnitId,
    constructorName: name.text,
    reservedLayoutName: projection.physicalReservation.reservationKey,
  });
}

/** Join retained L1 syntax to current L2 and source-callable ABI records. */
export function planIrFnctorParameterPreselection(
  input: PlanIrFnctorParameterPreselectionInput,
): IrFnctorParameterPreselectionPlan | undefined {
  const { ctx, sourceFile, identityContext } = input;
  if (
    !irFnctorArgumentProjectionRouteIsActive(ctx, input.route) ||
    ctx.irPlanningIdentityContext !== identityContext ||
    identityContext.sourceIdBySourceFile.get(sourceFile) === undefined
  ) {
    return undefined;
  }
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile)!;
  const retained = retainIrFnctorArgumentProjections(
    sourceFile,
    sourceId,
    identityContext,
    input.authority,
    input.projections,
  );
  if (retained?.length !== 1) return undefined;
  const projection = retained[0]!;
  if (
    projection.sourceId !== sourceId ||
    projection.sourceFile !== sourceFile ||
    projection.calleeParameterIndex !== 0 ||
    projection.calleeDeclaration.parameters.length !== 1 ||
    projection.calleeDeclaration.parameters[0] !== projection.calleeParameterDeclaration ||
    projection.calleeParameterDeclaration.type !== undefined
  ) {
    return undefined;
  }
  const shape = buildCurrentShape(projection);
  if (!shape) return undefined;
  const physical = exactResolvedPhysicalContract(ctx, shape, projection);
  if (!physical) return undefined;
  const preselection = exactSourceCallable(ctx, projection.calleeUnitId, physical.instanceCarrier);
  if (!preselection) return undefined;
  const topology = exactFieldReadTopology(
    input.authority.checker,
    projection.calleeDeclaration,
    projection.calleeParameterDeclaration,
  );
  if (!topology) return undefined;
  const frozenShape = Object.freeze({
    ...shape,
    fields: Object.freeze(shape.fields.map((field) => Object.freeze({ ...field }))),
    captures: Object.freeze(shape.captures.map((capture) => Object.freeze({ ...capture }))),
    userParamTypes: Object.freeze(shape.userParamTypes.map((type) => Object.freeze({ ...type }))),
    constructorIdentity: Object.freeze({ ...shape.constructorIdentity }),
  });
  return Object.freeze({
    kind: "fnctor-parameter-preselection",
    projection,
    shape: frozenShape,
    selectorKind: "object",
    overrideType: Object.freeze(irFnctor(frozenShape)),
    ownerUnitId: projection.calleeUnitId,
    parameterDeclaration: projection.calleeParameterDeclaration,
    parameterIndex: 0,
    fieldReads: topology.fieldReads,
    stringSliceCall: topology.stringSliceCall,
    valueConsumerCall: topology.valueConsumerCall,
    physical,
    preselection,
  });
}

/** Recheck every mutable module/registry record immediately before a plan is consumed. */
export function irFnctorParameterPreselectionIsCurrent(
  ctx: CodegenContext,
  plan: IrFnctorParameterPreselectionPlan,
): boolean {
  const shape = buildCurrentShape(plan.projection);
  if (!shape || !irFnctorShapeEquals(shape, plan.shape)) return false;
  const physical = exactResolvedPhysicalContract(ctx, shape, plan.projection);
  if (
    !physical ||
    !sameValType(physical.instanceCarrier, plan.physical.instanceCarrier) ||
    !sameValType(physical.fieldCarrier, plan.physical.fieldCarrier) ||
    physical.fieldIndex !== plan.physical.fieldIndex ||
    physical.fieldRefinement !== plan.physical.fieldRefinement
  ) {
    return false;
  }
  const current = exactSourceCallable(ctx, plan.ownerUnitId, physical.instanceCarrier);
  return (
    current !== undefined &&
    current.handle === plan.preselection.handle &&
    current.func === plan.preselection.func &&
    current.typeIdx === plan.preselection.typeIdx &&
    current.type === plan.preselection.type
  );
}
