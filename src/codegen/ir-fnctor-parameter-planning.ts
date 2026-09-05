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
import { irRuntimeFuncRef } from "../ir/callable-bindings.js";
import { irTypeBindingKey } from "../ir/abi-bindings.js";
import {
  retainIrFnctorArgumentProjections,
  type IrFnctorArgumentProjection,
  type IrFnctorArgumentProjectionAuthority,
} from "../ir/fnctor-argument-projection.js";
import { irFnctorShapeEquals, type IrFnctorShape } from "../ir/fnctor-abi.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { irFnctor, irVal, type IrClosureSignature, type IrType } from "../ir/nodes.js";
import type { ValType } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { resolveGlobalParseBuiltin } from "./global-builtin-resolution.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import {
  irFnctorArgumentProjectionRouteIsActive,
  type IrFnctorArgumentProjectionRoute,
} from "./ir-fnctor-admission.js";
import { buildStandaloneIrFnctorShape } from "./program-abi-fnctor-producer.js";
import { canonicalProgramAbiValType, cloneProgramAbiValType } from "./program-abi-signatures.js";
import type {
  IrFnctorFieldReadPlan,
  IrFnctorNativeStringBoundaryPlan,
  IrFnctorParameterPreselectionPlan,
  IrFnctorSourceCallablePlan,
} from "../ir/ast-lowering-plans.js";

export type {
  IrFnctorFieldReadPlan,
  IrFnctorNativeStringBoundaryPlan,
  IrFnctorParameterPreselectionPlan,
  IrFnctorSourceCallablePlan,
} from "../ir/ast-lowering-plans.js";

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
  physicalParams: readonly ValType[],
  result: ValType,
): IrFnctorSourceCallablePlan | undefined {
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
    type.params.length !== physicalParams.length ||
    type.params.some((param, index) => !sameValType(param, physicalParams[index]!)) ||
    type.results.length !== 1 ||
    !sameValType(type.results[0]!, result)
  ) {
    return undefined;
  }
  return Object.freeze({ handle, func, typeIdx, type });
}

/**
 * The exact linked parser consumer keeps the native-string carrier in its
 * current source-callable slot. The carrier may be nullable or non-null and
 * the boolean may retain its branded i32 marker, so this proof checks the
 * authenticated shape without manufacturing either physical type.
 */
function exactNativeStringSourceCallable(
  ctx: CodegenContext,
  ownerUnitId: IrFnctorArgumentProjection["calleeUnitId"],
): IrFnctorSourceCallablePlan | undefined {
  const registry = ctx.programAbiSourceCallables;
  if (registry?.ctx !== ctx || registry.identityContext !== ctx.irPlanningIdentityContext || ctx.anyStrTypeIdx < 0) {
    return undefined;
  }
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
  const stringParam = type?.kind === "func" ? type.params[0] : undefined;
  const booleanParam = type?.kind === "func" ? type.params[1] : undefined;
  if (
    !type ||
    type.kind !== "func" ||
    ctx.mod.types[typeIdx] !== type ||
    type.params.length !== 2 ||
    (stringParam?.kind !== "ref" && stringParam?.kind !== "ref_null") ||
    stringParam.typeIdx !== ctx.anyStrTypeIdx ||
    booleanParam?.kind !== "i32" ||
    type.results.length !== 1 ||
    !sameValType(type.results[0]!, { kind: "f64" })
  ) {
    return undefined;
  }
  return Object.freeze({ handle, func, typeIdx, type });
}

interface ExactStringToNumberTopology {
  readonly declaration: ts.FunctionDeclaration;
  readonly stringParameter: ts.ParameterDeclaration;
  readonly booleanParameter: ts.ParameterDeclaration;
  readonly parseIntCall: ts.CallExpression;
  readonly parseFloatCall: ts.CallExpression;
  readonly replaceCall: ts.CallExpression;
}

function exactStringToNumberTopology(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  consumerCall: ts.CallExpression,
): ExactStringToNumberTopology | undefined {
  if (!ts.isIdentifier(consumerCall.expression) || consumerCall.expression.text !== "stringToNumber") return undefined;
  const oracle = ctx.oracle;
  if (!oracle) return undefined;
  const declaration = oracle.valueDeclarationOf(consumerCall.expression);
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.getSourceFile() !== sourceFile ||
    declaration.parent !== sourceFile ||
    !declaration.name ||
    declaration.name.text !== "stringToNumber" ||
    declaration.parameters.length !== 2 ||
    declaration.parameters.some((parameter) => parameter.type !== undefined) ||
    !ts.isIdentifier(declaration.parameters[0]!.name) ||
    !ts.isIdentifier(declaration.parameters[1]!.name) ||
    !declaration.body ||
    declaration.body.statements.length !== 2
  ) {
    return undefined;
  }
  const stringParameter = declaration.parameters[0]!;
  const booleanParameter = declaration.parameters[1]!;
  const guard = declaration.body.statements[0]!;
  const tail = declaration.body.statements[1]!;
  if (
    !ts.isIfStatement(guard) ||
    guard.elseStatement !== undefined ||
    !ts.isIdentifier(guard.expression) ||
    !symbolOwnsParameter(ctx.checker, guard.expression, booleanParameter)
  ) {
    return undefined;
  }
  const guardedReturn = ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements.length === 1 && ts.isReturnStatement(guard.thenStatement.statements[0]!)
      ? guard.thenStatement.statements[0]
      : undefined
    : ts.isReturnStatement(guard.thenStatement)
      ? guard.thenStatement
      : undefined;
  const parseIntExpression = guardedReturn?.expression;
  if (
    !parseIntExpression ||
    !ts.isCallExpression(parseIntExpression) ||
    !ts.isIdentifier(parseIntExpression.expression) ||
    resolveGlobalParseBuiltin(parseIntExpression.expression, oracle) !== "parseInt" ||
    parseIntExpression.arguments.length !== 2 ||
    !ts.isIdentifier(parseIntExpression.arguments[0]!) ||
    !symbolOwnsParameter(ctx.checker, parseIntExpression.arguments[0]!, stringParameter) ||
    !ts.isNumericLiteral(parseIntExpression.arguments[1]!) ||
    parseIntExpression.arguments[1]!.text !== "8"
  ) {
    return undefined;
  }
  if (!ts.isReturnStatement(tail) || !tail.expression || !ts.isCallExpression(tail.expression)) return undefined;
  const parseFloatCall = tail.expression;
  if (
    !ts.isIdentifier(parseFloatCall.expression) ||
    resolveGlobalParseBuiltin(parseFloatCall.expression, oracle) !== "parseFloat" ||
    parseFloatCall.arguments.length !== 1
  ) {
    return undefined;
  }
  const replaceCall = parseFloatCall.arguments[0]!;
  if (
    !ts.isCallExpression(replaceCall) ||
    !ts.isPropertyAccessExpression(replaceCall.expression) ||
    replaceCall.expression.questionDotToken !== undefined ||
    replaceCall.expression.name.text !== "replace" ||
    !ts.isIdentifier(replaceCall.expression.expression) ||
    !symbolOwnsParameter(ctx.checker, replaceCall.expression.expression, stringParameter) ||
    replaceCall.questionDotToken !== undefined ||
    (replaceCall.typeArguments?.length ?? 0) !== 0 ||
    replaceCall.arguments.length !== 2 ||
    replaceCall.arguments[0]!.kind !== ts.SyntaxKind.RegularExpressionLiteral ||
    replaceCall.arguments[0]!.getText() !== "/_/g" ||
    !ts.isStringLiteralLike(replaceCall.arguments[1]!) ||
    replaceCall.arguments[1]!.text !== ""
  ) {
    return undefined;
  }
  return Object.freeze({
    declaration,
    stringParameter,
    booleanParameter,
    parseIntCall: parseIntExpression,
    parseFloatCall,
    replaceCall,
  });
}

function exactNativeStringBoundaries(
  sourceId: IrFnctorArgumentProjection["sourceId"],
  sourceFile: ts.SourceFile,
  ownerUnitId: IrFnctorArgumentProjection["calleeUnitId"],
  topology: ExactStringToNumberTopology,
  ctx: CodegenContext,
): readonly IrFnctorNativeStringBoundaryPlan[] | undefined {
  const rows = [
    {
      call: topology.parseIntCall,
      builtin: "parseInt" as const,
      signature: {
        params: [irVal({ kind: "externref" }), irVal({ kind: "f64" })],
        returnType: irVal({ kind: "f64" }),
      } satisfies IrClosureSignature,
    },
    {
      call: topology.parseFloatCall,
      builtin: "parseFloat" as const,
      signature: {
        params: [irVal({ kind: "externref" })],
        returnType: irVal({ kind: "f64" }),
      } satisfies IrClosureSignature,
    },
  ];
  if (!ctx.ambientBuiltinFuncMap || rows.some(({ builtin }) => !ctx.ambientBuiltinFuncMap.has(builtin)))
    return undefined;
  return Object.freeze(
    rows.map(({ call, builtin, signature }) =>
      Object.freeze({
        kind: "fnctor-native-string-boundary" as const,
        ownerUnitId,
        sourceId,
        sourceFile,
        call,
        builtin,
        argumentIndex: 0 as const,
        argument: call.arguments[0]!,
        target: irRuntimeFuncRef(builtin),
        signature,
      }),
    ),
  );
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
  const preselection = exactSourceCallable(ctx, projection.calleeUnitId, [physical.instanceCarrier], { kind: "f64" });
  if (!preselection) return undefined;
  const topology = exactFieldReadTopology(
    input.authority.checker,
    projection.calleeDeclaration,
    projection.calleeParameterDeclaration,
  );
  if (!topology) return undefined;
  let valueConsumer: IrFnctorParameterPreselectionPlan["valueConsumer"];
  let nativeStringBoundaries: readonly IrFnctorNativeStringBoundaryPlan[] | undefined;
  const consumerTopology = exactStringToNumberTopology(ctx, sourceFile, topology.valueConsumerCall);
  const consumerUnitId = consumerTopology
    ? identityContext.unitIdByDeclaration.get(consumerTopology.declaration)
    : undefined;
  if (consumerTopology && consumerUnitId !== undefined) {
    const consumerPreselection = exactNativeStringSourceCallable(ctx, consumerUnitId);
    const boundaries = exactNativeStringBoundaries(sourceId, sourceFile, consumerUnitId, consumerTopology, ctx);
    if (consumerPreselection && boundaries) {
      valueConsumer = Object.freeze({
        unitId: consumerUnitId,
        declaration: consumerTopology.declaration,
        parameterDeclaration: consumerTopology.stringParameter,
        parameterIndex: 0,
        parameterPhysicalType: cloneProgramAbiValType(consumerPreselection.type.params[0]!),
        signature: {
          params: [{ kind: "string" as const }, irVal({ kind: "i32", boolean: true })],
          returnType: irVal({ kind: "f64" }),
        },
        preselection: consumerPreselection,
      });
      nativeStringBoundaries = boundaries;
    }
  }
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
    ...(valueConsumer && consumerTopology ? { nativeStringReplaceCall: consumerTopology.replaceCall } : {}),
    physical,
    preselection,
    ...(valueConsumer ? { valueConsumer } : {}),
    ...(nativeStringBoundaries ? { nativeStringBoundaries } : {}),
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
  const current = exactSourceCallable(ctx, plan.ownerUnitId, [physical.instanceCarrier], { kind: "f64" });
  if (
    current === undefined ||
    current.handle !== plan.preselection.handle ||
    current.func !== plan.preselection.func ||
    current.typeIdx !== plan.preselection.typeIdx ||
    current.type !== plan.preselection.type
  ) {
    return false;
  }
  if (!plan.valueConsumer) return true;
  const topology = exactStringToNumberTopology(ctx, plan.projection.sourceFile, plan.valueConsumerCall);
  if (
    !topology ||
    topology.declaration !== plan.valueConsumer.declaration ||
    topology.stringParameter !== plan.valueConsumer.parameterDeclaration ||
    topology.replaceCall !== plan.nativeStringReplaceCall
  ) {
    return false;
  }
  const consumer = exactNativeStringSourceCallable(ctx, plan.valueConsumer.unitId);
  if (
    consumer === undefined ||
    consumer.handle !== plan.valueConsumer.preselection.handle ||
    consumer.func !== plan.valueConsumer.preselection.func ||
    consumer.typeIdx !== plan.valueConsumer.preselection.typeIdx ||
    consumer.type !== plan.valueConsumer.preselection.type ||
    !sameValType(consumer.type.params[0]!, plan.valueConsumer.parameterPhysicalType)
  ) {
    return false;
  }
  const boundaries = exactNativeStringBoundaries(
    plan.projection.sourceId,
    plan.projection.sourceFile,
    plan.valueConsumer.unitId,
    topology,
    ctx,
  );
  if (!boundaries || boundaries.length !== (plan.nativeStringBoundaries?.length ?? 0)) return false;
  return boundaries.every((boundary, index) => {
    const previous = plan.nativeStringBoundaries?.[index];
    return (
      previous !== undefined &&
      previous.call === boundary.call &&
      previous.builtin === boundary.builtin &&
      previous.target.binding.kind === boundary.target.binding.kind &&
      previous.target.binding.kind === "runtime" &&
      boundary.target.binding.kind === "runtime" &&
      previous.target.binding.symbol === boundary.target.binding.symbol
    );
  });
}
