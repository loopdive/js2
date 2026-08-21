// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irSupportFuncRef } from "../ir/callable-bindings.js";
import type { IrUnitId } from "../ir/identity.js";
import { findConstructorImplementation } from "./ast-modifiers.js";
import {
  compileClassBodies,
  skipExactPreparedClassBody,
  skipPreparedClassConstructorBody,
  type ClassBodyCompileRouting,
} from "./class-bodies.js";
import { assertAstFreeClassConstructorNewWrapper } from "./class-constructor-wrapper.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";

type ExecutableClassMember =
  | ts.ConstructorDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function executableClassMember(member: ts.ClassElement): member is ExecutableClassMember {
  return (
    (ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)) &&
    member.body !== undefined
  );
}

function hasDecorators(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

function hasResidualClassBodySyntax(declaration: ts.ClassDeclaration): boolean {
  let residual = false;
  const visit = (node: ts.Node): void => {
    if (residual) return;
    if (hasDecorators(node)) {
      residual = true;
      return;
    }
    if (node !== declaration && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      residual = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  if (residual) return true;

  return declaration.members.some((member) => {
    if ("name" in member && member.name && ts.isComputedPropertyName(member.name)) return true;
    if (ts.isClassStaticBlockDeclaration(member)) return true;
    if (ts.isPropertyDeclaration(member)) return member.initializer !== undefined;
    if (executableClassMember(member)) return false;
    return member.kind !== ts.SyntaxKind.SemicolonClassElement;
  });
}

function appendUnique<T>(target: T[] | undefined, values: readonly T[]): void {
  if (!target) return;
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function hasExactOrdinaryHeritage(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration,
  className: string,
  classSuperTypeIdx: number | undefined,
): boolean {
  const extendsClauses = declaration.heritageClauses?.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  if (!extendsClauses?.length) return true;
  if (extendsClauses.length !== 1 || extendsClauses[0]!.types.length !== 1) return false;
  const heritage = extendsClauses[0]!.types[0]!;
  if (!ts.isIdentifier(heritage.expression) || (heritage.typeArguments?.length ?? 0) !== 0) return false;
  const parentName = ctx.classParentMap.get(className);
  if (!parentName || parentName !== heritage.expression.text) return false;
  const parentDeclaration = ctx.oracle
    .declarationsOf(heritage.expression)
    .find((candidate): candidate is ts.ClassDeclaration => ts.isClassDeclaration(candidate));
  const parentClassId = parentDeclaration
    ? ctx.irPlanningIdentityContext?.classIdByDeclaration.get(parentDeclaration)
    : undefined;
  const parentLayout = parentClassId ? ctx.programAbiTypes?.layoutForClass(parentClassId) : undefined;
  return (
    parentLayout !== undefined &&
    parentLayout.typeIdx === classSuperTypeIdx &&
    parentLayout.typeIdx === ctx.structMap.get(parentName) &&
    ctx.mod.types[parentLayout.typeIdx] === parentLayout.type &&
    ctx.structFields.get(parentName) === parentLayout.type.fields
  );
}

/**
 * Correlate an exact top-level standalone class without entering the legacy
 * class-body walker. Eligibility is intentionally whole-class and atomic:
 * mixed/unsupported classes return false without mutation, while a mismatch
 * after every member was certified Prepared fails closed.
 */
export function tryCorrelateFullyPreparedStandaloneClassBodies(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration,
  funcByName: ReadonlyMap<string, number>,
  routing: ClassBodyCompileRouting | undefined,
): boolean {
  if (process.env.JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER === "0") return false;
  if (!ctx.standalone || ctx.wasi || ctx.currentFunc != null || !routing || !declaration.name) return false;
  if (!ts.isSourceFile(declaration.parent) || hasResidualClassBodySyntax(declaration)) return false;

  const className = declaration.name.text;
  if (ctx.classExternrefBackedSet.has(className) || ctx.classBuiltinParentMap.has(className)) return false;

  const ctor = findConstructorImplementation(declaration);
  if (!ctor?.body) return false;
  const members = declaration.members.filter(executableClassMember);
  if (members.length === 0 || members.some((member) => ts.isConstructorDeclaration(member) && member !== ctor)) {
    return false;
  }

  const identity = ctx.irPlanningIdentityContext;
  const classId = identity?.classIdByDeclaration.get(declaration);
  if (!identity || !classId) return false;
  const unitIds: IrUnitId[] = [];
  for (const member of members) {
    const unitId = identity.unitIdByDeclaration.get(member);
    if (
      unitId === undefined ||
      routing.skipBodyUnitIds?.has(unitId) !== true ||
      routing.preserveSkippedBodyUnitIds?.has(unitId) !== true
    ) {
      return false;
    }
    unitIds.push(unitId);
  }

  const exactUnitIds = new Set(unitIds);
  const classUnits = identity.inventory.allUnits.filter((unit) => unit.lexicalOwnerId === classId);
  if (classUnits.length !== exactUnitIds.size || classUnits.some((unit) => !exactUnitIds.has(unit.id))) return false;

  const classRecord = identity.inventory.classes.find((record) => record.id === classId);
  if (
    !classRecord ||
    classRecord.declarationKind !== "declaration" ||
    classRecord.lexicalOwnerId !== null ||
    identity.declarationByClassId.get(classId) !== declaration
  ) {
    throw new Error(`prepared class ${className} has no exact top-level class identity`);
  }
  const layout = ctx.programAbiTypes?.layoutForClass(classId);
  if (
    !layout ||
    ctx.structMap.get(className) !== layout.typeIdx ||
    ctx.structFields.get(className) !== layout.type.fields ||
    ctx.mod.types[layout.typeIdx] !== layout.type
  ) {
    throw new Error(`prepared class ${className} has no exact installed Program ABI layout`);
  }
  if (!hasExactOrdinaryHeritage(ctx, declaration, className, layout.type.superTypeIdx)) return false;
  for (let index = 0; index < members.length; index++) {
    const member = members[index]!;
    const unitId = unitIds[index]!;
    const unit = identity.unitByUnitId.get(unitId);
    const terminal = identity.terminalByUnitId.get(unitId);
    const callable = ctx.programAbiClassCallables?.functionForUnit(unitId);
    if (
      unit !== terminal ||
      terminal?.observedKind !== "class-member" ||
      terminal.lexicalOwnerId !== classId ||
      identity.declarationByUnitId.get(unitId) !== member ||
      !callable ||
      callable.body.length === 0
    ) {
      throw new Error(`prepared class ${className} member ${unitId} has no exact installed callable`);
    }
  }

  const ctorUnitId = identity.unitIdByDeclaration.get(ctor)!;
  const initFuncIdx = ctx.programAbiClassCallables?.handleForUnit(ctorUnitId);
  const newFuncName = classMemberFuncKey(ctx, `${className}_new`);
  const newTarget = irSupportFuncRef(classId, "class-constructor-new", newFuncName);
  const newFuncIdx =
    newTarget.binding.kind === "support"
      ? ctx.programAbiClassCallables?.handleForSupport(newTarget.binding.bindingId)
      : undefined;
  const newFunc = newFuncIdx === undefined ? undefined : definedFuncAt(ctx, newFuncIdx);
  if (
    initFuncIdx === undefined ||
    newFuncIdx === undefined ||
    ctx.funcMap.get(newFuncName) !== newFuncIdx ||
    ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_init`)) !== initFuncIdx ||
    !newFunc
  ) {
    throw new Error(`prepared class ${className} has no exact allocator-owned constructor support pair`);
  }
  if (process.env.JS2WASM_TEST_TAMPER_PREPARED_CLASS_NEW?.split(",").includes(className)) {
    newFunc.body = [{ op: "unreachable" }];
  }
  assertAstFreeClassConstructorNewWrapper(ctx, {
    className,
    structTypeIdx: layout.typeIdx,
    fields: layout.type.fields,
    newFuncIdx,
    initFuncIdx,
  });

  const stagedNames: string[] = [];
  const stagedUnitIds: IrUnitId[] = [];
  const stagedRouting: ClassBodyCompileRouting = {
    ...routing,
    skippedNames: stagedNames,
    skippedUnitIds: stagedUnitIds,
    skippedImplicitConstructorUnitIds: [],
  };
  if (
    !skipPreparedClassConstructorBody(ctx, funcByName, stagedRouting, declaration, ctor, className, `${className}_new`)
  ) {
    throw new Error(`prepared class ${className} constructor correlation was withdrawn after certification`);
  }
  for (const member of members) {
    if (ts.isConstructorDeclaration(member)) continue;
    if (!skipExactPreparedClassBody(ctx, member, stagedRouting)) {
      throw new Error(`prepared class ${className} member correlation was withdrawn after certification`);
    }
  }
  if (stagedUnitIds.length !== exactUnitIds.size || stagedUnitIds.some((unitId) => !exactUnitIds.has(unitId))) {
    throw new Error(`prepared class ${className} produced an incomplete exact correlation`);
  }

  appendUnique(routing.skippedNames, stagedNames);
  appendUnique(routing.skippedUnitIds, stagedUnitIds);
  return true;
}

/** Preserve the legacy walker for every class outside the exact cutover. */
export function routeTopLevelClassBodies(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration,
  funcByName: Map<string, number>,
  routing: ClassBodyCompileRouting | undefined,
): void {
  if (!tryCorrelateFullyPreparedStandaloneClassBodies(ctx, declaration, funcByName, routing)) {
    compileClassBodies(ctx, declaration, funcByName, undefined, routing);
  }
}
