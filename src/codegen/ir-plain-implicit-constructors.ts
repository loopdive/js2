// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClassId, IrUnitId } from "../ir/identity.js";
import type { IrClassShape } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { FieldDef, FuncHandle, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { installAstFreeClassConstructorNewWrapper } from "./class-constructor-wrapper.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";

function hasStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

/**
 * Install the AST-free support pair for exact plain implicit constructors used
 * by the prepared owner population. Derived forwarding, instance fields, and
 * host-backed construction remain on the direct path until their complete
 * contracts are represented.
 */
export function preparePlainImplicitConstructorSupports(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly ownerUnitIds: ReadonlySet<IrUnitId>;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
}): ReadonlySet<IrUnitId> {
  const referencedClassDeclarations = new Set<ts.ClassDeclaration>();
  for (const ownerUnitId of input.ownerUnitIds) {
    const root = input.identityPlan.identityContext.declarationByUnitId.get(ownerUnitId);
    if (!root) continue;
    const visit = (node: ts.Node): void => {
      if (node !== root && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
        return;
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        for (const declaration of input.ctx.oracle.declarationsOf(node.expression)) {
          if (ts.isClassDeclaration(declaration) && declaration.parent === input.sourceFile) {
            referencedClassDeclarations.add(declaration);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  const registry = input.ctx.programAbiClassCallables;
  const types = input.ctx.programAbiTypes;
  if (!registry || !types) return new Set();
  const staged: {
    readonly unitId: IrUnitId;
    readonly shape: IrClassShape;
    readonly structTypeIdx: number;
    readonly fields: readonly FieldDef[];
    readonly newFuncIdx: FuncHandle;
    readonly initFuncIdx: FuncHandle;
    readonly initFunc: WasmFunction;
  }[] = [];
  for (const declaration of referencedClassDeclarations) {
    const classId = input.identityPlan.identityContext.classIdByDeclaration.get(declaration);
    const shape = classId ? input.classShapesById.get(classId) : undefined;
    const className = declaration.name?.text;
    if (
      !className ||
      !shape ||
      classId !== shape.classId ||
      input.classShapes.get(className) !== shape ||
      input.identityPlan.identityContext.declarationByClassId.get(shape.classId) !== declaration ||
      declaration.parent !== input.sourceFile ||
      declaration.heritageClauses?.length ||
      declaration.members.some(ts.isConstructorDeclaration) ||
      declaration.members.some((member) => ts.isPropertyDeclaration(member) && !hasStaticModifier(member)) ||
      shape.constructorParams.length !== 0 ||
      input.ctx.classExternrefBackedSet.has(className)
    ) {
      continue;
    }
    const unitId = input.identityPlan.identityContext.unitIdByDeclaration.get(declaration);
    const unit = unitId ? input.identityPlan.identityContext.unitByUnitId.get(unitId) : undefined;
    const newTarget = shape.constructorTarget;
    const initTarget = shape.constructorInitTarget;
    const layout = types.layoutForClass(shape.classId);
    if (
      !unitId ||
      unit?.kind !== "class-implicit-constructor" ||
      unit.lexicalOwnerId !== shape.classId ||
      unit.terminalOwnerId !== null ||
      input.identityPlan.identityContext.terminalByUnitId.has(unitId) ||
      input.identityPlan.identityContext.declarationByUnitId.get(unitId) !== declaration ||
      newTarget?.binding.kind !== "support" ||
      initTarget?.binding.kind !== "unit" ||
      initTarget.binding.unitId !== unitId ||
      !layout
    ) {
      continue;
    }
    const newFuncIdx = registry.handleForSupport(newTarget.binding.bindingId);
    const initFuncIdx = registry.handleForUnit(unitId);
    const newFunc = newFuncIdx === undefined ? undefined : definedFuncAt(input.ctx, newFuncIdx);
    const initFunc = initFuncIdx === undefined ? undefined : definedFuncAt(input.ctx, initFuncIdx);
    const newSignature = newFunc ? input.ctx.mod.types[newFunc.typeIdx] : undefined;
    const initSignature = initFunc ? input.ctx.mod.types[initFunc.typeIdx] : undefined;
    const selfType: ValType = { kind: "ref", typeIdx: layout.typeIdx };
    if (
      newFuncIdx === undefined ||
      initFuncIdx === undefined ||
      !newFunc ||
      !initFunc ||
      !newSignature ||
      newSignature.kind !== "func" ||
      newSignature.params.length !== 0 ||
      newSignature.results.length !== 1 ||
      !sameValType(newSignature.results[0]!, selfType) ||
      !initSignature ||
      initSignature.kind !== "func" ||
      initSignature.params.length !== 1 ||
      !sameValType(initSignature.params[0]!, selfType) ||
      initSignature.results.length !== 1 ||
      !sameValType(initSignature.results[0]!, selfType)
    ) {
      continue;
    }
    staged.push({
      unitId,
      shape,
      structTypeIdx: layout.typeIdx,
      fields: layout.type.fields,
      newFuncIdx,
      initFuncIdx,
      initFunc,
    });
  }

  for (const candidate of staged) {
    const target = candidate.shape.constructorTarget;
    if (target?.binding.kind !== "support") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `plain implicit constructor ${candidate.unitId} lost its prepared _new support binding`,
      );
    }
    const preparedNewFuncIdx = registry.prepareSupport(target.binding.bindingId);
    if (preparedNewFuncIdx !== candidate.newFuncIdx) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `plain implicit constructor ${candidate.unitId} changed its _new allocator during preparation`,
      );
    }
    candidate.initFunc.locals = [];
    candidate.initFunc.body = [{ op: "local.get", index: 0 }];
    const preparedInitFuncIdx = registry.preparePlainImplicitConstructorUnit(candidate.unitId);
    if (preparedInitFuncIdx !== candidate.initFuncIdx) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `plain implicit constructor ${candidate.unitId} changed its _init allocator during preparation`,
      );
    }
    installAstFreeClassConstructorNewWrapper(input.ctx, {
      className: candidate.shape.className,
      structTypeIdx: candidate.structTypeIdx,
      fields: candidate.fields,
      newFuncIdx: candidate.newFuncIdx,
      initFuncIdx: candidate.initFuncIdx,
    });
  }
  return new Set(staged.map(({ unitId }) => unitId));
}
