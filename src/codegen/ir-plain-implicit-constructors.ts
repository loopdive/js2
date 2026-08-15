// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { isBoundedPreparedNestedOrdinaryClass } from "../ir/class-accessor-safety.js";
import type { IrClassId, IrUnitId } from "../ir/identity.js";
import type { IrClassShape } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { FieldDef, FuncHandle, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { installAstFreeClassConstructorNewWrapper } from "./class-constructor-wrapper.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";

type ImplicitConstructorClass = ts.ClassDeclaration | ts.ClassExpression;

function hasStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

/**
 * (#3522) Class owners whose implicit constructor may be prepared.
 *
 * Two disjoint admissions:
 *
 *   - an exact TOP-LEVEL class declaration, the family established by the
 *     2026-08-12 plain implicit-constructor checkpoint, whose derived
 *     forwarding chain is represented by the parent-init walk below; and
 *   - an exact NESTED bounded ordinary class — declaration or the
 *     `const C = class { … }` expression form. `isBoundedPreparedNestedOrdinaryClass`
 *     rejects heritage, decorators, statics, computed keys, and initialized
 *     fields, so its ClassDefinitionEvaluation is inert in the containing
 *     frame and it can never carry a parent chain. That is what keeps this
 *     admission out of the shadow-identity inheritance surface (#4448): a
 *     nested class admitted here has `parentShape === undefined` by
 *     construction, so the forwarding path below is unreachable for it.
 *
 * Anything else — a class expression at module scope, a nested class with
 * heritage or static/initialized members — stays direct.
 */
function isAdmissibleImplicitConstructorClass(
  declaration: ImplicitConstructorClass,
  sourceFile: ts.SourceFile,
): boolean {
  if (ts.isClassDeclaration(declaration) && declaration.parent === sourceFile) return true;
  return declaration.parent !== sourceFile && isBoundedPreparedNestedOrdinaryClass(declaration);
}

/**
 * The exact class owner a `new <identifier>(...)` callee denotes, when that
 * owner is one this pass may prepare. A class expression is reached only
 * through its immutable `const` binding, matching the selector's bounded
 * projection; the binding identity is re-proven by
 * `boundedPreparedNestedOrdinaryClassBindingName` on the selector side.
 */
function implicitConstructorClassForDeclaration(declaration: ts.Declaration): ImplicitConstructorClass | undefined {
  if (ts.isClassDeclaration(declaration)) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isClassExpression(declaration.initializer) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return declaration.initializer;
  }
  return undefined;
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

/**
 * Install the AST-free support pair for exact implicit constructors used by
 * the prepared owner population. Local-user derived forwarding is represented
 * as an exact parent-init chain. Initialized instance fields and host-backed
 * construction remain direct until their complete contracts are represented.
 */
export function prepareImplicitConstructorSupports(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly ownerUnitIds: ReadonlySet<IrUnitId>;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
}): ReadonlySet<IrUnitId> {
  const referencedClassDeclarations = new Set<ImplicitConstructorClass>();
  for (const ownerUnitId of input.ownerUnitIds) {
    const root = input.identityPlan.identityContext.declarationByUnitId.get(ownerUnitId);
    if (!root) continue;
    const visit = (node: ts.Node): void => {
      if (node !== root && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
        return;
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        for (const declaration of input.ctx.oracle.declarationsOf(node.expression)) {
          const owner = implicitConstructorClassForDeclaration(declaration);
          if (owner && isAdmissibleImplicitConstructorClass(owner, input.sourceFile)) {
            referencedClassDeclarations.add(owner);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  // A synthesized derived constructor forwards to its exact parent `_init`.
  // Pull every local ancestor into the support-preparation population so a
  // leaf construction cannot seal while an implicit middle constructor is
  // still backed by the direct class emitter.
  for (const declaration of [...referencedClassDeclarations]) {
    let classId = input.identityPlan.identityContext.classIdByDeclaration.get(declaration);
    const seen = new Set<IrClassId>();
    while (classId && !seen.has(classId)) {
      seen.add(classId);
      const parentShape = input.classShapesById.get(classId)?.parent;
      if (!parentShape) break;
      const parentDeclaration = input.identityPlan.identityContext.declarationByClassId.get(parentShape.classId);
      if (
        parentDeclaration &&
        ts.isClassDeclaration(parentDeclaration) &&
        isAdmissibleImplicitConstructorClass(parentDeclaration, input.sourceFile)
      ) {
        referencedClassDeclarations.add(parentDeclaration);
      }
      classId = parentShape.classId;
    }
  }

  const registry = input.ctx.programAbiClassCallables;
  const types = input.ctx.programAbiTypes;
  if (!registry || !types) return new Set();
  let staged: {
    readonly unitId: IrUnitId;
    readonly shape: IrClassShape;
    readonly structTypeIdx: number;
    readonly fields: readonly FieldDef[];
    readonly newFuncIdx: FuncHandle;
    readonly initFuncIdx: FuncHandle;
    readonly initFunc: WasmFunction;
    readonly selfParamIndex: number;
    readonly parentInitUnitId?: IrUnitId;
    readonly parentInitFuncIdx?: FuncHandle;
    /** `null` for a top-level class; the enclosing prepared owner when nested. */
    readonly containingTerminalOwnerId: IrUnitId | null;
  }[] = [];
  for (const declaration of referencedClassDeclarations) {
    const classId = input.identityPlan.identityContext.classIdByDeclaration.get(declaration);
    const shape = classId ? input.classShapesById.get(classId) : undefined;
    const parentShape = shape?.parent;
    // A class declaration owns its source name; an admitted class expression is
    // anonymous and carries the projected name the shape was registered under.
    // Requiring the declaration name to AGREE when present keeps the existing
    // top-level proof exactly as strong, while the `classShapes` round trip
    // below remains the bidirectional identity check in both forms.
    const className = shape?.className;
    const sourceName = declaration.name?.text;
    const hasExtends =
      declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ?? false;
    if (
      !className ||
      !shape ||
      (sourceName !== undefined && sourceName !== className) ||
      classId !== shape.classId ||
      input.classShapes.get(className) !== shape ||
      input.identityPlan.identityContext.declarationByClassId.get(shape.classId) !== declaration ||
      !isAdmissibleImplicitConstructorClass(declaration, input.sourceFile) ||
      (hasExtends && !parentShape) ||
      declaration.members.some(ts.isConstructorDeclaration) ||
      declaration.members.some(
        (member) => ts.isPropertyDeclaration(member) && member.initializer && !hasStaticModifier(member),
      ) ||
      (!parentShape && shape.constructorParams.length !== 0) ||
      input.ctx.classExternrefBackedSet.has(className)
    ) {
      continue;
    }
    const unitId = input.identityPlan.identityContext.unitIdByDeclaration.get(declaration);
    const unit = unitId ? input.identityPlan.identityContext.unitByUnitId.get(unitId) : undefined;
    const newTarget = shape.constructorTarget;
    const initTarget = shape.constructorInitTarget;
    const layout = types.layoutForClass(shape.classId);
    const parentInitTarget = parentShape?.constructorInitTarget;
    const parentLayout = parentShape ? types.layoutForClass(parentShape.classId) : undefined;
    // A top-level implicit constructor has no containing terminal. A NESTED one
    // records its enclosing executable as `terminalOwnerId`, and that is exactly
    // the atomicity obligation: its support pair may be installed only when the
    // containing owner is itself in THIS preparation transaction. Otherwise the
    // owner would keep a legacy body while its class allocation was prepared —
    // the split-ownership state R3 exists to prevent.
    const containingTerminalOwnerId = unit?.terminalOwnerId ?? null;
    const containingOwnerPrepared =
      containingTerminalOwnerId === null || input.ownerUnitIds.has(containingTerminalOwnerId);
    if (
      !unitId ||
      unit?.kind !== "class-implicit-constructor" ||
      unit.lexicalOwnerId !== shape.classId ||
      !containingOwnerPrepared ||
      (containingTerminalOwnerId !== null && !isBoundedPreparedNestedOrdinaryClass(declaration)) ||
      input.identityPlan.identityContext.terminalByUnitId.has(unitId) ||
      input.identityPlan.identityContext.declarationByUnitId.get(unitId) !== declaration ||
      newTarget?.binding.kind !== "support" ||
      initTarget?.binding.kind !== "unit" ||
      initTarget.binding.unitId !== unitId ||
      !layout ||
      (parentShape &&
        (parentInitTarget?.binding.kind !== "unit" ||
          !parentLayout ||
          (input.identityPlan.identityContext.unitByUnitId.get(parentInitTarget.binding.unitId)?.kind ===
            "class-implicit-constructor" &&
            input.identityPlan.identityContext.unitByUnitId.get(parentInitTarget.binding.unitId)?.terminalOwnerId !==
              null)))
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
    const parentInitUnitId = parentInitTarget?.binding.kind === "unit" ? parentInitTarget.binding.unitId : undefined;
    const parentInitFuncIdx = parentInitUnitId ? registry.handleForUnit(parentInitUnitId) : undefined;
    const parentInitFunc = parentInitFuncIdx === undefined ? undefined : definedFuncAt(input.ctx, parentInitFuncIdx);
    const parentInitSignature = parentInitFunc ? input.ctx.mod.types[parentInitFunc.typeIdx] : undefined;
    const parentSelfType: ValType | undefined = parentLayout
      ? { kind: "ref", typeIdx: parentLayout.typeIdx }
      : undefined;
    if (
      newFuncIdx === undefined ||
      initFuncIdx === undefined ||
      !newFunc ||
      !initFunc ||
      !newSignature ||
      newSignature.kind !== "func" ||
      newSignature.params.length !== shape.constructorParams.length ||
      newSignature.results.length !== 1 ||
      !sameValType(newSignature.results[0]!, selfType) ||
      !initSignature ||
      initSignature.kind !== "func" ||
      initSignature.params.length !== newSignature.params.length + 1 ||
      !newSignature.params.every((param, index) => sameValType(param, initSignature.params[index]!)) ||
      !sameValType(initSignature.params.at(-1)!, selfType) ||
      initSignature.results.length !== 1 ||
      !sameValType(initSignature.results[0]!, selfType) ||
      (parentShape &&
        (parentInitUnitId === undefined ||
          parentInitFuncIdx === undefined ||
          !parentInitSignature ||
          parentInitSignature.kind !== "func" ||
          parentInitSignature.params.length !== newSignature.params.length + 1 ||
          !newSignature.params.every((param, index) => sameValType(param, parentInitSignature.params[index]!)) ||
          !parentSelfType ||
          !sameValType(parentInitSignature.params.at(-1)!, parentSelfType) ||
          parentInitSignature.results.length !== 1 ||
          !sameValType(parentInitSignature.results[0]!, parentSelfType)))
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
      selfParamIndex: newSignature.params.length,
      ...(parentInitUnitId ? { parentInitUnitId } : {}),
      ...(parentInitFuncIdx !== undefined ? { parentInitFuncIdx } : {}),
      containingTerminalOwnerId,
    });
  }

  // Preparation is component-atomic across the synthesized parent chain. A
  // derived support body may reference an implicit parent only when that exact
  // parent support is staged too, and may reference an explicit constructor
  // only when its terminal body belongs to this preparation transaction.
  for (let changed = true; changed; ) {
    changed = false;
    const stagedUnitIds = new Set(staged.map(({ unitId }) => unitId));
    const filtered = staged.filter((candidate) => {
      if (!candidate.parentInitUnitId) return true;
      const parentUnit = input.identityPlan.identityContext.unitByUnitId.get(candidate.parentInitUnitId);
      return parentUnit?.kind === "class-implicit-constructor"
        ? stagedUnitIds.has(candidate.parentInitUnitId)
        : input.ownerUnitIds.has(candidate.parentInitUnitId);
    });
    if (filtered.length !== staged.length) {
      staged = filtered;
      changed = true;
    }
  }

  const inheritanceDepth = (shape: IrClassShape): number => {
    let depth = 0;
    const seen = new Set<IrClassId>();
    for (let current = shape.parent; current && !seen.has(current.classId); current = current.parent) {
      seen.add(current.classId);
      depth++;
    }
    return depth;
  };
  staged.sort((left, right) => inheritanceDepth(left.shape) - inheritanceDepth(right.shape));

  for (const candidate of staged) {
    const target = candidate.shape.constructorTarget;
    if (target?.binding.kind !== "support") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `implicit constructor ${candidate.unitId} lost its prepared _new support binding`,
      );
    }
    const preparedNewFuncIdx = registry.prepareSupport(target.binding.bindingId);
    if (preparedNewFuncIdx !== candidate.newFuncIdx) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `implicit constructor ${candidate.unitId} changed its _new allocator during preparation`,
      );
    }
    candidate.initFunc.locals = [];
    candidate.initFunc.body = [];
    if (candidate.parentInitFuncIdx !== undefined) {
      for (let index = 0; index < candidate.selfParamIndex; index++) {
        candidate.initFunc.body.push({ op: "local.get", index });
      }
      candidate.initFunc.body.push({ op: "local.get", index: candidate.selfParamIndex });
      candidate.initFunc.body.push({ op: "call", funcIdx: candidate.parentInitFuncIdx });
      candidate.initFunc.body.push({ op: "drop" });
    }
    candidate.initFunc.body.push({ op: "local.get", index: candidate.selfParamIndex });
    const preparedInitFuncIdx = registry.prepareImplicitConstructorUnit(candidate.unitId, {
      selfParamIndex: candidate.selfParamIndex,
      ...(candidate.parentInitUnitId && candidate.parentInitFuncIdx !== undefined
        ? { parent: { unitId: candidate.parentInitUnitId, funcIdx: candidate.parentInitFuncIdx } }
        : {}),
      containingTerminalOwnerId: candidate.containingTerminalOwnerId,
    });
    if (preparedInitFuncIdx !== candidate.initFuncIdx) {
      throw new IrInvariantError(
        "missing-function-slot",
        "resolve",
        `implicit constructor ${candidate.unitId} changed its _init allocator during preparation`,
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
