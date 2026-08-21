// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irImportFuncRef, irRuntimeFuncRef, irUnitFuncRef } from "./callable-bindings.js";
import { createDerivedIrUnitId, type IrSourceId, type IrUnitId } from "./identity.js";
import {
  asVal,
  irVal,
  type IrClosureSignature,
  type IrDomCallbackAuthority,
  type IrFuncRef,
  type IrType,
  type IrValueId,
} from "./nodes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";
import { demoteToLegacy } from "./outcomes.js";
import type { IrPromiseDelayCertification, IrPromiseDelayResolver } from "./promise-delay.js";

/** Target-neutral symbol whose standalone provider owns the native Promise/timer projection. */
export const IR_NATIVE_PROMISE_DELAY_FN = "__ir_promise_delay_native";

export type IrPromiseDelayRuntimeProjection = "host-executor" | "standalone-native";

/** Exact node-identity plan produced only for the certified Promise delay. */
export interface IrPromiseDelayLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  /** Compatibility label used only for current lifted/backend names. */
  readonly ownerName: string;
  readonly construction: ts.NewExpression;
  readonly executor: ts.ArrowFunction & { readonly body: ts.Block };
  readonly timerCall: ts.CallExpression;
  readonly timerCallback: ts.ArrowFunction;
  readonly resolveCall: ts.CallExpression;
  readonly executorSignature: IrClosureSignature;
  readonly timerSignature: IrClosureSignature;
  readonly executorCaptureNames: readonly string[];
  readonly timerCaptureNames: readonly string[];
  readonly executorTarget: IrFuncRef;
  readonly timerTarget: IrFuncRef;
  readonly executorLiftedName: string;
  readonly timerLiftedName: string;
  readonly runtimeProjection: IrPromiseDelayRuntimeProjection;
}

export interface IrPromiseDelayLoweringPlans {
  readonly constructions: ReadonlyMap<ts.NewExpression, IrPromiseDelayLoweringPlan>;
  readonly timers: ReadonlyMap<ts.CallExpression, IrPromiseDelayLoweringPlan>;
  readonly resolves: ReadonlyMap<ts.CallExpression, IrPromiseDelayLoweringPlan>;
}

export interface ExactClosureLoweringOptions {
  readonly orderedReadonlyCaptures?: readonly string[];
  readonly expectedLiftedName?: string;
  readonly expectedLiftedTarget?: IrFuncRef;
  readonly allowConciseVoidBody?: boolean;
  /** Exact inline host callback consumed once by `__make_callback(-2, ...)`. */
  readonly hostOneShot?: boolean;
  /** Exact reusable callback admitted only by the standalone DOM authority. */
  readonly domCallbackAuthority?: IrDomCallbackAuthority;
}

type PromiseDelayBuilder = Pick<IrFunctionBuilder, "emitCall" | "emitCallablePack" | "typeOf">;

/** Narrow facade keeps this exact lowering independent of from-ast's private context. */
export interface IrPromiseDelayLoweringHost {
  readonly builder: PromiseDelayBuilder;
  readonly funcName: string;
  readonly ownerUnitId: IrUnitId | undefined;
  lowerExpr(expr: ts.Expression, expected: IrType): IrValueId;
  lowerClosure(
    expr: ts.ArrowFunction,
    signature: IrClosureSignature,
    captures: ReadonlySet<string>,
    exact: ExactClosureLoweringOptions,
  ): IrValueId;
}

function planningInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

interface ValidatedPromiseDelayOwnerPopulation {
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
  readonly declarationByUnitId: ReadonlyMap<IrUnitId, ts.FunctionDeclaration>;
}

function isTopLevelFunctionUnitKind(kind: string, lexicalOwnerId: unknown): boolean {
  return kind === "top-level-function" || (kind === "synthetic-support" && lexicalOwnerId === null);
}

/**
 * Revalidate the mutable AST against the authoritative inventory before using
 * exact declaration objects as Promise owners. This deliberately checks the
 * complete executable top-level FunctionDeclaration population, not only the
 * selected subset, so a cloned/reparsed or subsequently mutated AST cannot be
 * partially accepted through an otherwise valid unit ID.
 */
function validatePromiseDelayOwnerPopulation(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
): ValidatedPromiseDelayOwnerPopulation {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return planningInvariant(
      "source-record-mismatch",
      `Promise-delay source ${sourceFile.fileName} does not resolve back to its exact planning SourceFile`,
    );
  }

  const expectedIds: IrUnitId[] = [];
  const expectedIdSet = new Set<IrUnitId>();
  for (const unit of identityContext.inventory.allUnits) {
    if (unit.sourceId !== sourceId || !isTopLevelFunctionUnitKind(unit.kind, unit.lexicalOwnerId)) continue;
    const declaration = identityContext.declarationByUnitId.get(unit.id);
    if (!declaration || !ts.isFunctionDeclaration(declaration)) {
      return planningInvariant(
        "missing-unit-declaration",
        `Promise-delay top-level function unit ${unit.id} has no exact FunctionDeclaration`,
      );
    }
    expectedIds.push(unit.id);
    expectedIdSet.add(unit.id);
  }

  const currentIds: IrUnitId[] = [];
  const declarationByUnitId = new Map<IrUnitId, ts.FunctionDeclaration>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const unitId = identityContext.unitIdByDeclaration.get(statement);
    if (!statement.body) {
      if (unitId !== undefined && expectedIdSet.has(unitId)) {
        return planningInvariant(
          "unit-record-mismatch",
          `Promise-delay owner unit ${unitId} no longer has its inventoried executable body`,
        );
      }
      continue;
    }
    const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
    if (
      unitId === undefined ||
      !unit ||
      unit.sourceId !== sourceId ||
      !expectedIdSet.has(unitId) ||
      identityContext.declarationByUnitId.get(unitId) !== statement ||
      statement.parent !== sourceFile ||
      statement.getSourceFile() !== sourceFile
    ) {
      return planningInvariant(
        "missing-unit-declaration",
        `Promise-delay source ${sourceFile.fileName} contains an unindexed executable FunctionDeclaration`,
      );
    }
    currentIds.push(unitId);
    declarationByUnitId.set(unitId, statement);
  }

  if (currentIds.length !== expectedIds.length || currentIds.some((unitId, index) => unitId !== expectedIds[index])) {
    return planningInvariant(
      "unit-record-mismatch",
      `Promise-delay source ${sourceFile.fileName} no longer matches its authoritative function population`,
    );
  }
  return { sourceId, sourceFile, declarationByUnitId };
}

function requirePromiseDelayOwnerDeclaration(
  ownerUnitId: IrUnitId,
  population: ValidatedPromiseDelayOwnerPopulation,
  identityContext: IrPlanningIdentityContext,
): ts.FunctionDeclaration {
  const declaration = population.declarationByUnitId.get(ownerUnitId);
  const unit = identityContext.unitByUnitId.get(ownerUnitId);
  if (
    !declaration ||
    !unit ||
    unit.sourceId !== population.sourceId ||
    identityContext.unitIdByDeclaration.get(declaration) !== ownerUnitId ||
    identityContext.declarationByUnitId.get(ownerUnitId) !== declaration
  ) {
    return planningInvariant(
      "unit-record-mismatch",
      `selected Promise-delay owner ${ownerUnitId} is not an exact top-level FunctionDeclaration in ${population.sourceFile.fileName}`,
    );
  }
  return declaration;
}

export function collectIrPromiseDelayOwners(
  sourceFile: ts.SourceFile,
  selectedOwnerUnitIds: ReadonlySet<IrUnitId>,
  resolver: IrPromiseDelayResolver | undefined,
  identityContext: IrPlanningIdentityContext,
): ReadonlyMap<IrUnitId, IrPromiseDelayCertification> {
  const population = validatePromiseDelayOwnerPopulation(sourceFile, identityContext);
  for (const ownerUnitId of selectedOwnerUnitIds) {
    requirePromiseDelayOwnerDeclaration(ownerUnitId, population, identityContext);
  }

  const byOwner = new Map<IrUnitId, IrPromiseDelayCertification>();
  if (!resolver) return byOwner;
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const ownerUnitId = identityContext.unitIdByDeclaration.get(statement);
    if (ownerUnitId === undefined || !selectedOwnerUnitIds.has(ownerUnitId)) continue;
    requirePromiseDelayOwnerDeclaration(ownerUnitId, population, identityContext);
    const certification = resolver.resolveOwner(statement);
    if (certification) {
      if (certification.owner !== statement) {
        return planningInvariant(
          "unit-record-mismatch",
          `Promise-delay certification for ${ownerUnitId} returned a different owner declaration`,
        );
      }
      byOwner.set(ownerUnitId, certification);
    }
  }
  return byOwner;
}

export function buildIrPromiseDelayLoweringPlans(
  byOwner: ReadonlyMap<IrUnitId, IrPromiseDelayCertification>,
  selectedOwnerUnitIds: ReadonlySet<IrUnitId>,
  identityContext: IrPlanningIdentityContext,
  runtimeProjection: IrPromiseDelayRuntimeProjection = "host-executor",
): IrPromiseDelayLoweringPlans {
  const constructions = new Map<ts.NewExpression, IrPromiseDelayLoweringPlan>();
  const timers = new Map<ts.CallExpression, IrPromiseDelayLoweringPlan>();
  const resolves = new Map<ts.CallExpression, IrPromiseDelayLoweringPlan>();

  const populationBySourceId = new Map<IrSourceId, ValidatedPromiseDelayOwnerPopulation>();
  const requirePopulationForOwner = (ownerUnitId: IrUnitId): ValidatedPromiseDelayOwnerPopulation => {
    const unit = identityContext.unitByUnitId.get(ownerUnitId);
    if (!unit) {
      return planningInvariant(
        "unit-record-mismatch",
        `Promise-delay owner ${ownerUnitId} is absent from the authoritative planning inventory`,
      );
    }
    let population = populationBySourceId.get(unit.sourceId);
    if (!population) {
      const sourceFile = identityContext.sourceFileBySourceId.get(unit.sourceId);
      if (!sourceFile) {
        return planningInvariant(
          "source-record-mismatch",
          `Promise-delay owner ${ownerUnitId} belongs to a source without an exact planning SourceFile`,
        );
      }
      population = validatePromiseDelayOwnerPopulation(sourceFile, identityContext);
      populationBySourceId.set(unit.sourceId, population);
    }
    requirePromiseDelayOwnerDeclaration(ownerUnitId, population, identityContext);
    return population;
  };

  for (const ownerUnitId of selectedOwnerUnitIds) requirePopulationForOwner(ownerUnitId);
  for (const [ownerUnitId, certification] of byOwner) {
    const population = requirePopulationForOwner(ownerUnitId);
    const declaration = requirePromiseDelayOwnerDeclaration(ownerUnitId, population, identityContext);
    if (certification.owner !== declaration) {
      return planningInvariant(
        "unit-record-mismatch",
        `Promise-delay certification for ${ownerUnitId} does not retain its exact owner declaration`,
      );
    }
    if (!selectedOwnerUnitIds.has(ownerUnitId)) continue;
    const ownerName = declaration.name?.text;
    if (!ownerName || certification.owner.name !== declaration.name || certification.owner.body !== declaration.body) {
      return planningInvariant(
        "unit-record-mismatch",
        `Promise-delay certification owner ${ownerUnitId} no longer has its exact named function shape`,
      );
    }
    const executorLiftedName = `${ownerName}__closure_${certification.executorOrdinal}`;
    const timerLiftedName = `${executorLiftedName}__closure_${certification.timerOrdinal}`;
    const plan: IrPromiseDelayLoweringPlan = {
      ownerUnitId,
      ownerName,
      construction: certification.construction,
      executor: certification.executor,
      timerCall: certification.timerCall,
      timerCallback: certification.timerCallback,
      resolveCall: certification.resolveCall,
      executorSignature: { params: [irVal({ kind: "externref" })], returnType: null },
      timerSignature: { params: [], returnType: null },
      executorCaptureNames: certification.executorCaptureNames,
      timerCaptureNames: certification.timerCaptureNames,
      executorTarget: irUnitFuncRef({
        unitId: createDerivedIrUnitId({
          parentId: ownerUnitId,
          role: "lifted-closure",
          ordinal: certification.executorOrdinal,
        }),
        name: executorLiftedName,
      }),
      timerTarget: irUnitFuncRef({
        unitId: createDerivedIrUnitId({
          parentId: ownerUnitId,
          role: "lifted-closure",
          ordinal: certification.timerOrdinal,
        }),
        name: timerLiftedName,
      }),
      executorLiftedName,
      timerLiftedName,
      runtimeProjection,
    };
    constructions.set(certification.construction, plan);
    timers.set(certification.timerCall, plan);
    resolves.set(certification.resolveCall, plan);
  }
  return { constructions, timers, resolves };
}

function requireMatchingPromiseDelayOwner(plan: IrPromiseDelayLoweringPlan, host: IrPromiseDelayLoweringHost): void {
  if (host.ownerUnitId === undefined) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(
      `ir/from-ast: Promise delay plan cannot be consumed without an authoritative ownerUnitId (${host.funcName})`,
    );
  }
  if (plan.ownerUnitId !== host.ownerUnitId) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(
      `ir/from-ast: stale Promise delay plan owner ${plan.ownerUnitId} does not match ${host.ownerUnitId} (${host.funcName})`,
    );
  }
}

function lowerResolveCall(
  expr: ts.CallExpression,
  plan: IrPromiseDelayLoweringPlan,
  host: IrPromiseDelayLoweringHost,
  statementPosition: boolean,
): IrValueId {
  requireMatchingPromiseDelayOwner(plan, host);
  if (plan.runtimeProjection !== "host-executor") {
    throw new Error(`ir/from-ast: standalone Promise-delay resolve escaped its native provider (${host.funcName})`);
  }
  if (
    expr !== plan.resolveCall ||
    !statementPosition ||
    !ts.isIdentifier(expr.expression) ||
    expr.arguments.length !== 1
  ) {
    // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
    throw new Error(`ir/from-ast: malformed Promise delay resolve plan (${host.funcName})`);
  }
  const resolve = host.lowerExpr(expr.expression, irVal({ kind: "externref" }));
  if (asVal(host.builder.typeOf(resolve))?.kind !== "externref") {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: Promise resolve binding is not raw externref (${host.funcName})`,
    );
  }
  const value = host.lowerExpr(expr.arguments[0]!, irVal({ kind: "f64" }));
  if (asVal(host.builder.typeOf(value))?.kind !== "f64") {
    demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: Promise resolve value is not f64 (${host.funcName})`);
  }
  const result = host.builder.emitCall(
    irImportFuncRef("env", "__call_1_f64"),
    [resolve, value],
    irVal({ kind: "f64" }),
  );
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: __call_1_f64 produced no value (${host.funcName})`);
  return result;
}

function lowerTimerCall(
  expr: ts.CallExpression,
  plan: IrPromiseDelayLoweringPlan,
  host: IrPromiseDelayLoweringHost,
  statementPosition: boolean,
): IrValueId {
  requireMatchingPromiseDelayOwner(plan, host);
  if (plan.runtimeProjection !== "host-executor") {
    throw new Error(`ir/from-ast: standalone Promise-delay timer escaped its native provider (${host.funcName})`);
  }
  if (
    expr !== plan.timerCall ||
    !statementPosition ||
    expr.arguments.length !== 2 ||
    expr.arguments[0] !== plan.timerCallback ||
    plan.timerSignature.params.length !== 0 ||
    plan.timerSignature.returnType !== null
  ) {
    // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
    throw new Error(`ir/from-ast: malformed Promise delay timer plan (${host.funcName})`);
  }
  const timerClosure = host.lowerClosure(plan.timerCallback, plan.timerSignature, new Set(plan.timerCaptureNames), {
    orderedReadonlyCaptures: plan.timerCaptureNames,
    expectedLiftedName: plan.timerLiftedName,
    expectedLiftedTarget: plan.timerTarget,
    allowConciseVoidBody: true,
  });
  const packedTimer = host.builder.emitCallablePack(timerClosure, plan.timerSignature);
  const delay = host.lowerExpr(expr.arguments[1]!, irVal({ kind: "f64" }));
  if (asVal(host.builder.typeOf(delay))?.kind !== "f64") {
    demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: Promise delay timeout is not f64 (${host.funcName})`);
  }
  const boxedDelay = host.builder.emitCall(
    irImportFuncRef("env", "__box_number"),
    [delay],
    irVal({ kind: "externref" }),
  );
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (boxedDelay === null) throw new Error(`ir/from-ast: __box_number produced no value (${host.funcName})`);
  const timerResult = host.builder.emitCall(
    irImportFuncRef("env", "__timer_set_timeout"),
    [packedTimer, boxedDelay],
    irVal({ kind: "externref" }),
  );
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (timerResult === null) throw new Error(`ir/from-ast: __timer_set_timeout produced no value (${host.funcName})`);
  return timerResult;
}

export function tryLowerPromiseDelayCall(
  expr: ts.CallExpression,
  statementPosition: boolean,
  plans: IrPromiseDelayLoweringPlans | undefined,
  makeHost: () => IrPromiseDelayLoweringHost,
): IrValueId | undefined {
  const timer = plans?.timers.get(expr);
  if (timer) return lowerTimerCall(expr, timer, makeHost(), statementPosition);
  const resolve = plans?.resolves.get(expr);
  return resolve ? lowerResolveCall(expr, resolve, makeHost(), statementPosition) : undefined;
}

export function tryLowerPromiseDelayConstruction(
  expr: ts.NewExpression,
  plans: IrPromiseDelayLoweringPlans | undefined,
  makeHost: () => IrPromiseDelayLoweringHost,
): IrValueId | undefined {
  const plan = plans?.constructions.get(expr);
  if (!plan) return undefined;
  const host = makeHost();
  requireMatchingPromiseDelayOwner(plan, host);
  if (
    expr !== plan.construction ||
    expr.arguments?.length !== 1 ||
    expr.arguments[0] !== plan.executor ||
    plan.executorSignature.params.length !== 1 ||
    asVal(plan.executorSignature.params[0]!)?.kind !== "externref" ||
    plan.executorSignature.returnType !== null
  ) {
    // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
    throw new Error(`ir/from-ast: malformed Promise delay construction plan (${host.funcName})`);
  }
  if (plan.runtimeProjection === "standalone-native") {
    const delayExpr = plan.timerCall.arguments[1];
    const valueExpr = plan.resolveCall.arguments[0];
    if (!delayExpr || !valueExpr) {
      throw new Error(`ir/from-ast: standalone Promise delay lost its certified operands (${host.funcName})`);
    }
    const delay = host.lowerExpr(delayExpr, irVal({ kind: "f64" }));
    const value = host.lowerExpr(valueExpr, irVal({ kind: "f64" }));
    if (asVal(host.builder.typeOf(delay))?.kind !== "f64" || asVal(host.builder.typeOf(value))?.kind !== "f64") {
      demoteToLegacy(
        "operand-coercion-unsupported",
        `ir/from-ast: standalone Promise delay operands are not grounded f64 values (${host.funcName})`,
      );
    }
    const promise = host.builder.emitCall(irRuntimeFuncRef(IR_NATIVE_PROMISE_DELAY_FN), [delay, value], {
      kind: "extern",
      className: "Promise",
    });
    if (promise === null) {
      throw new Error(`ir/from-ast: ${IR_NATIVE_PROMISE_DELAY_FN} produced no value (${host.funcName})`);
    }
    return promise;
  }
  const executor = host.lowerClosure(plan.executor, plan.executorSignature, new Set(plan.executorCaptureNames), {
    orderedReadonlyCaptures: plan.executorCaptureNames,
    expectedLiftedName: plan.executorLiftedName,
    expectedLiftedTarget: plan.executorTarget,
  });
  const packedExecutor = host.builder.emitCallablePack(executor, plan.executorSignature);
  const promise = host.builder.emitCall(irImportFuncRef("env", "Promise_new"), [packedExecutor], {
    kind: "extern",
    className: "Promise",
  });
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (promise === null) throw new Error(`ir/from-ast: Promise_new produced no value (${host.funcName})`);
  return promise;
}

export function validateExactCapturePlan(
  orderedNames: readonly string[],
  referencedNames: ReadonlySet<string>,
  ownParams: ReadonlySet<string>,
  lookup: (name: string) => "local" | "other" | undefined,
  funcName: string,
): void {
  const ordered = new Set(orderedNames);
  for (const name of referencedNames) {
    if (ownParams.has(name)) continue;
    const kind = lookup(name);
    if (kind !== undefined && (kind !== "local" || !ordered.has(name))) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: exact closure capture plan omitted binding "${name}" (${funcName})`);
    }
  }
  for (const name of orderedNames) {
    if (lookup(name) !== "local") {
      // invariant (producer-promise): the prepared exact proof promised this shape — #4502.
      throw new Error(`ir/from-ast: exact closure capture "${name}" is not a local in scope (${funcName})`);
    }
  }
}

export function exactClosureLiftedName(prefix: string, ordinal: number, expected: string | undefined): string {
  const actual = `${prefix}__closure_${ordinal}`;
  if (expected !== undefined && expected !== actual) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: exact closure lift name ${actual} != planned ${expected} (${prefix})`);
  }
  return actual;
}
