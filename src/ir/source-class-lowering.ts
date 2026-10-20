// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import {
  lowerFunctionAstToIr,
  lowerPreparedImplicitClassConstructorToIr,
  type AstToIrOptions,
  type IrFromAstResolver,
  type IrFunctionSourceMapContext,
} from "./from-ast.js";
import type { SourceClassPlan, SourceClassPlans } from "./source-class-plans.js";
import type { IrTerminalUnitRecord } from "../shared/contracts/ir-unit-inventory.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";

/** Dispatch original class nodes; implicit source constructors use a typed builder. */
export function lowerSourceClassUnit(plan: SourceClassPlan, unitId: IrUnitId, options: AstToIrOptions) {
  const shape = plan.data.shape;
  if (unitId === plan.data.constructorUnitId) {
    const ctorOptions = {
      ...options,
      funcName: `${shape.className}_init`,
      constructorInitClassShape: shape,
      paramTypeOverrides: shape.constructorParams,
      constructorFieldInitializers: plan.initializers,
    };
    return plan.constructor
      ? lowerFunctionAstToIr(plan.constructor, ctorOptions)
      : lowerPreparedImplicitClassConstructorToIr(plan.declaration, ctorOptions);
  }
  const node = plan.methods.get(unitId)!;
  const descriptor = shape.methods.find((m) => m.placement?.unitId === unitId)!;
  if (!node || !ts.isMethodDeclaration(node)) throw Error("missing original class method");
  return lowerFunctionAstToIr(node, {
    ...options,
    paramTypeOverrides: descriptor.params,
    returnTypeOverride: descriptor.returnType,
    ...(descriptor.memberKind === "static" ? {} : { selfParam: { type: { kind: "class", shape } } }),
  });
}

/** Assemble the finite original-class lowering context outside the whole-source owner. */
export function lowerSourceClassProgramUnit(
  plan: SourceClassPlan,
  unit: IrTerminalUnitRecord,
  classes: SourceClassPlans,
  identity: IrPlanningIdentityContext,
  options: Omit<AstToIrOptions, "ownerUnitId">,
  builtins: (statements: readonly ts.Statement[]) => IrFromAstResolver,
  sourceMap?: IrFunctionSourceMapContext,
) {
  classes.assertCurrent();
  const original = plan.methods.get(unit.id) ?? plan.constructor ?? plan.declaration;
  return lowerSourceClassUnit(plan, unit.id, {
    ...options,
    ownerUnitId: unit.id,
    funcName: unit.displayName,
    identityContext: identity,
    classShapes: classes.lexicalShapes(original),
    resolver: {
      ...options.resolver,
      ...builtins(identity.sourceFileBySourceId.get(unit.sourceId)!.statements),
      sourceClassShape: (node) => classes.shapeAt(node),
    },
    ...(sourceMap === undefined ? {} : { sourceMap }),
    numericThrow: "number-boundary",
  });
}

/** Class wrappers outside the nominal shape graph must not create anonymous back-edges. */
export function ownSourceClassBodyTypes<T>(body: T): T {
  const copies = new Map<object, unknown>();
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (
      typeof record.classId === "string" &&
      Array.isArray(record.fields) &&
      Array.isArray(record.methods) &&
      Array.isArray(record.constructorParams)
    )
      return value;
    if (record.kind === "class" && record.shape) return { ...record, shape: record.shape };
    const known = copies.get(value);
    if (known) return known;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      copies.set(value, result);
      for (const item of value) result.push(copy(item));
      return result;
    }
    const result = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
    copies.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw Error("source class body contains executable DATA");
      Object.defineProperty(result, key, { ...descriptor, value: copy(descriptor.value) });
    }
    return result;
  };
  return copy(body) as T;
}
