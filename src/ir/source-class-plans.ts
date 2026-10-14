// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { irUnitFuncRef, irSupportFuncRef } from "./callable-bindings.js";
import { IR_CLASS_SHAPE_CELL, type IrClassShape, type IrType, type IrClassMethodDescriptor } from "./core/types.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import type { IrClassId, IrUnitId } from "../shared/contracts/ir-identity.js";
import { requireIrPlanningOwnerUnitId, type IrPlanningIdentityContext } from "./planning-identity.js";
import { collectIrClassInstanceInitializers, irClassInstanceFieldName } from "./class-instance-initializers.js";
import type { IrPreparedSourceClass } from "./program/class-preparation.js";
import { assertSourceClassPreparation } from "./program/class-preparation.js";
import { inferClassInitializerArrayTypes } from "./array-element-inference.js";
import { IrUnsupportedError } from "./outcomes.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";

type Callable = ts.MethodDeclaration | ts.ConstructorDeclaration;
export interface SourceClassPlan {
  readonly data: IrPreparedSourceClass;
  readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
  readonly constructor: ts.ConstructorDeclaration | undefined;
  readonly initializers: NonNullable<ReturnType<typeof collectIrClassInstanceInitializers>>;
  readonly methods: ReadonlyMap<IrUnitId, ts.MethodDeclaration>;
}
export interface SourceClassPlans {
  readonly plans: readonly SourceClassPlan[];
  readonly byUnit: ReadonlyMap<IrUnitId, SourceClassPlan>;
  typeOf(node: ts.Node): IrType;
  classTypeOf(node: ts.Node): Extract<IrType, { kind: "class" }> | undefined;
  shapeAt(node: ts.Expression): IrClassShape | undefined;
  lexicalShapes(node: ts.Node): ReadonlyMap<string, IrClassShape>;
  readonly allocations: readonly { node: ts.NewExpression; classId: IrClassId; ownerUnitId: IrUnitId }[];
  assertCurrent(): void;
}
function refuse(detail: string): never {
  throw new IrUnsupportedError("class-member-unsupported", "build", `native source classes: ${detail}`);
}
function has(node: ts.Node, modifier: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === modifier) ?? false);
}
export function prepareSourceClassPlans(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  reportOwner?: (unitId: IrUnitId) => void,
): SourceClassPlans {
  const cells = new Map<IrClassId, IrClassShape>();
  const declarations = new Map<IrClassId, ts.ClassDeclaration | ts.ClassExpression>();
  for (const original of identity.inventory.classes) {
    const declaration = identity.declarationByClassId.get(original.id);
    if (!declaration || identity.classIdByDeclaration.get(declaration) !== original.id)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "class has no original bidirectional source identity",
      );
    declarations.set(original.id, declaration);
    cells.set(original.id, {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: original.id,
      className: original.displayName,
      fields: [],
      methods: [],
      constructorParams: [],
    });
  }
  const classForSymbol = (symbol: ts.Symbol | undefined): IrClassShape | undefined => {
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const ids = new Set<IrClassId>();
    for (const d of symbol?.declarations ?? []) {
      const source =
        ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer) ? d.initializer : d;
      if (ts.isClassDeclaration(source) || ts.isClassExpression(source)) {
        const id = identity.classIdByDeclaration.get(source);
        if (id) ids.add(id);
      }
    }
    return ids.size === 1 ? cells.get([...ids][0]!) : undefined;
  };
  const classTypeOf = (node: ts.Node): Extract<IrType, { kind: "class" }> | undefined => {
    const type = checker.getTypeAtLocation(node);
    if (type.getConstructSignatures().length) return undefined;
    const shape = classForSymbol(type.getSymbol()) ?? classForSymbol(type.aliasSymbol);
    return shape ? { kind: "class", shape } : undefined;
  };
  const typeOf = (node: ts.Node): IrType => {
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.NumberLike) return { kind: "val", val: { kind: "f64" } };
    if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "val", val: { kind: "i32", boolean: true } };
    if (type.flags & ts.TypeFlags.StringLike) return { kind: "string" };
    const nominal = classTypeOf(node);
    if (nominal) return nominal;
    return refuse(`unresolved class position at ${node.getSourceFile().fileName}:${node.getStart()}`);
  };
  const signature = (member: Callable) => {
    const params = member.parameters.map((p) => {
      if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer || p.modifiers?.length)
        refuse("optional/default/rest/destructured/parameter-property contract needs its source owner");
      return typeOf(p);
    });
    if (ts.isConstructorDeclaration(member)) return { params, result: null };
    const sig = checker.getSignatureFromDeclaration(member);
    if (!sig) return refuse("method has no authentic checker signature");
    const resultType = checker.getReturnTypeOfSignature(sig);
    const result =
      resultType.flags & ts.TypeFlags.Void
        ? null
        : member.type
          ? typeOf(member.type)
          : resultType.flags & ts.TypeFlags.NumberLike
            ? { kind: "val" as const, val: { kind: "f64" as const } }
            : resultType.flags & ts.TypeFlags.BooleanLike
              ? { kind: "val" as const, val: { kind: "i32" as const, boolean: true as const } }
              : refuse("inferred method result needs a complete typed source position");
    return { params, result };
  };
  const plans: SourceClassPlan[] = [];
  const byUnit = new Map<IrUnitId, SourceClassPlan>();
  for (const original of identity.inventory.classes) {
    const firstOwner = identity.inventory.terminalUnits.find((u) => u.lexicalOwnerId === original.id);
    const enclosingOwner = identity.inventory.allUnits.find(
      (u) => u.lexicalOwnerId === original.id && u.terminalOwnerId !== null,
    )?.terminalOwnerId;
    if (firstOwner) reportOwner?.(firstOwner.id);
    else if (enclosingOwner) reportOwner?.(enclosingOwner);
    const declaration = declarations.get(original.id)!;
    const shape = cells.get(original.id)!;
    if (has(declaration, ts.SyntaxKind.DeclareKeyword))
      refuse("erased ambient class declarations need their non-executable source contract");
    if (declaration.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword))
      refuse("superclass preparation remains with the held W1-C owner");
    if (ts.canHaveDecorators(declaration) && ts.getDecorators(declaration)?.length)
      refuse("decorated class definition requires its evaluation owner");
    const fields: { name: string; type: IrType }[] = [];
    const defaults: IrPreparedSourceClass["fieldIntents"][number][] = [];
    const methods: IrClassMethodDescriptor[] = [];
    const methodNodes = new Map<IrUnitId, ts.MethodDeclaration>();
    let ctorDeclaration: ts.ConstructorDeclaration | undefined;
    for (const [sourceOrdinal, member] of declaration.members.entries()) {
      const owner = identity.unitIdByDeclaration.get(member);
      if (owner && identity.terminalByUnitId.has(owner)) reportOwner?.(owner);
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
        refuse("accessor preparation remains with the held W1-C owner");
      if (
        ts.isClassStaticBlockDeclaration(member) ||
        (ts.isPropertyDeclaration(member) && has(member, ts.SyntaxKind.StaticKeyword))
      )
        refuse("static initialization needs its class-definition evaluation owner");
      if (ts.isPropertyDeclaration(member)) {
        const name = irClassInstanceFieldName(member.name);
        if (name === undefined || fields.some((f) => f.name === name))
          refuse("field key/duplicate contract is not exact");
        fields.push({ name, type: typeOf(member) });
        const unit = identity.unitIdByDeclaration.get(member);
        defaults.push({
          name,
          sourceOrdinal,
          default: "undefined",
          initializerUnitId: member.initializer ? (unit ?? refuse("field initializer lacks original unit")) : null,
        });
      } else if (ts.isConstructorDeclaration(member)) {
        if (!member.body) continue;
        if (ctorDeclaration || has(member, ts.SyntaxKind.StaticKeyword))
          refuse("constructor implementation census is ambiguous");
        ctorDeclaration = member;
      } else if (ts.isMethodDeclaration(member)) {
        if (
          !member.body ||
          member.asteriskToken ||
          has(member, ts.SyntaxKind.AsyncKeyword) ||
          has(member, ts.SyntaxKind.AbstractKeyword)
        )
          refuse("method body/async/generator contract is not prepared");
        const name = irClassInstanceFieldName(member.name);
        if (name === undefined) refuse("method property key is not exact");
        const unitId = identity.unitIdByDeclaration.get(member);
        if (!unitId) refuse("method lacks original unit");
        const isStatic = has(member, ts.SyntaxKind.StaticKeyword);
        const sig = signature(member);
        if (methods.some((m) => m.name === name && (m.memberKind === "static") === isStatic))
          refuse("duplicate method contract");
        methods.push({
          name,
          params: sig.params,
          returnType: sig.result,
          memberKind: isStatic ? "static" : "method",
          target: irUnitFuncRef({ unitId, name: identity.unitByUnitId.get(unitId)!.displayName }),
          placement: { classId: original.id, unitId, staticClassMember: isStatic },
        });
        methodNodes.set(unitId, member);
      } else refuse("unknown original class member");
    }
    const constructorUnitId = identity.unitIdByDeclaration.get(ctorDeclaration ?? declaration);
    if (!constructorUnitId) refuse("constructor lacks original source unit");
    if (!identity.terminalByUnitId.has(constructorUnitId))
      refuse("original nested constructor population requires its complete source owner");
    for (const id of methodNodes.keys())
      if (!identity.terminalByUnitId.has(id)) refuse("original method population requires its complete source owner");
    Object.assign(shape, {
      fields: fields.sort((a, b) => a.name.localeCompare(b.name)),
      methods,
      constructorParams: ctorDeclaration ? signature(ctorDeclaration).params : [],
      constructorInitTarget: irUnitFuncRef({ unitId: constructorUnitId, name: `${shape.className}_init` }),
      constructorTarget: irSupportFuncRef(original.id, "class-constructor-new", `${shape.className}_new`),
    });
    const initializers = collectIrClassInstanceInitializers(declaration);
    if (!initializers) refuse("initializer census has unresolved field key");
    reportOwner?.(constructorUnitId);
    inferClassInitializerArrayTypes(
      declaration,
      initializers.map((row) => row.expression),
    );
    const requireNoArrayBody = (node: ts.Node): void => {
      if (
        ts.isArrayLiteralExpression(node) ||
        ts.isArrayTypeNode(node) ||
        ts.isTupleTypeNode(node) ||
        (ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Array" &&
          !classForSymbol(checker.getSymbolAtLocation(node.expression)))
      )
        refuse("class member array source contracts require their complete source/vector owner");
      ts.forEachChild(node, requireNoArrayBody);
    };
    if (ctorDeclaration?.body) requireNoArrayBody(ctorDeclaration.body);
    for (const [id, method] of methodNodes) {
      reportOwner?.(id);
      requireNoArrayBody(method.body!);
    }

    const plan: SourceClassPlan = {
      declaration,
      constructor: ctorDeclaration,
      initializers,
      methods: methodNodes,
      data: {
        classId: original.id,
        sourceId: original.sourceId,
        constructorUnitId,
        constructorKind: ctorDeclaration ? "explicit" : "implicit",
        shape,
        fieldIntents: defaults,
      },
    };
    plans.push(plan);
    byUnit.set(constructorUnitId, plan);
    for (const id of methodNodes.keys()) byUnit.set(id, plan);
  }
  assertSourceClassPreparation(
    identity.inventory,
    plans.map((p) => p.data),
  );
  const shapeAt = (node: ts.Expression) => classForSymbol(checker.getSymbolAtLocation(node));
  const lexicalShapes = (node: ts.Node) => {
    const out = new Map<string, IrClassShape>();
    for (const symbol of checker.getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) {
      const shape = classForSymbol(symbol);
      if (shape) out.set(symbol.name, shape);
    }
    return out;
  };
  const snapshots: {
    node: ts.Node;
    kind: ts.SyntaxKind;
    text: unknown;
    parent: ts.Node;
    pos: number;
    end: number;
    children: readonly ts.Node[];
  }[] = [];
  const capture = (node: ts.Node): void => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    snapshots.push({
      node,
      kind: node.kind,
      text: Object.getOwnPropertyDescriptor(node, "text")?.value,
      parent: node.parent,
      pos: node.pos,
      end: node.end,
      children,
    });
    children.forEach(capture);
  };
  for (const declaration of declarations.values()) capture(declaration);
  const assertCurrent = () => {
    for (const row of snapshots) {
      const children: ts.Node[] = [];
      ts.forEachChild(row.node, (child) => {
        children.push(child);
      });
      if (
        row.node.kind !== row.kind ||
        row.node.parent !== row.parent ||
        row.node.pos !== row.pos ||
        row.node.end !== row.end ||
        Object.getOwnPropertyDescriptor(row.node, "text")?.value !== row.text ||
        children.length !== row.children.length ||
        children.some((node, i) => node !== row.children[i])
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "source class plan no longer matches original syntax nodes",
        );
    }
  };
  const allocations: { node: ts.NewExpression; classId: IrClassId; ownerUnitId: IrUnitId }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const shape = shapeAt(node.expression);
      if (shape)
        allocations.push({ node, classId: shape.classId, ownerUnitId: requireIrPlanningOwnerUnitId(identity, node) });
    }
    ts.forEachChild(node, visit);
  };
  for (const row of identity.inventory.sources) visit(identity.sourceFileBySourceId.get(row.id)!);
  return { plans, byUnit, typeOf, classTypeOf, shapeAt, lexicalShapes, allocations, assertCurrent };
}

/** Refuse an undeclared source capability before creating class allocation IR or facts. */
export function assertSourceClassPolicies(
  classes: SourceClassPlans | undefined,
  policies: readonly RuntimeManifestPolicy[],
  reportOwner: (unitId: IrUnitId) => void,
): void {
  const unsupportedClassAllocation = classes?.allocations[0];
  if (
    unsupportedClassAllocation &&
    policies.some((policy) => policy.backend === "linear" && policy.target !== "host")
  ) {
    classes!.assertCurrent();
    reportOwner(unsupportedClassAllocation.ownerUnitId);
    const source = unsupportedClassAllocation.node.getSourceFile();
    const site = source.getLineAndCharacterOfPosition(unsupportedClassAllocation.node.getStart(source));
    throw new IrUnsupportedError(
      "class-member-unsupported",
      "build",
      `native Linear class allocation needs its complete declared class-evidence producer (${unsupportedClassAllocation.classId} at ${source.fileName}:${site.line + 1}:${site.character + 1})`,
    );
  }
}

/** Populate direct-call sites from original constructor, method and initializer nodes. */
export function populateSourceClassDirectCalls(
  classes: SourceClassPlans | undefined,
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  signatures: ReadonlyMap<IrUnitId, IrDirectCallLoweringPlan["signature"]>,
  directCalls: Map<ts.CallExpression, IrDirectCallLoweringPlan>,
): void {
  if (classes) {
    for (const [ownerUnitId, plan] of classes.byUnit) {
      const roots: ts.Node[] =
        ownerUnitId === plan.data.constructorUnitId
          ? [...(plan.constructor ? [plan.constructor] : []), ...plan.initializers.map((i) => i.expression)]
          : [plan.methods.get(ownerUnitId)!];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          let symbol = checker.getSymbolAtLocation(node.expression);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const targetNode = symbol?.valueDeclaration;
          const targetUnitId = targetNode ? identity.unitIdByDeclaration.get(targetNode) : undefined;
          const signature = targetUnitId ? signatures.get(targetUnitId) : undefined;
          if (targetUnitId && signature)
            directCalls.set(node, {
              ownerUnitId,
              target: irUnitFuncRef({
                unitId: targetUnitId,
                name: identity.unitByUnitId.get(targetUnitId)!.displayName,
              }),
              signature,
            });
        }
        ts.forEachChild(node, visit);
      };
      for (const node of roots) visit(node);
    }
  }
}

/** No source class body may outrun its complete JavaScript semantic producer. */
export function refuseUnimplementedSourceClassSemantics(
  classes: SourceClassPlans | undefined,
  identity: IrPlanningIdentityContext,
  reportOwner: (unitId: IrUnitId) => void,
): void {
  if (classes === undefined) return;
  classes.assertCurrent();
  assertSourceClassPreparation(
    identity.inventory,
    classes.plans.map((plan) => plan.data),
  );
  for (const plan of classes.plans) {
    if (identity.declarationByClassId.get(plan.data.classId) !== plan.declaration)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "source class definition has foreign syntax identity",
      );
  }
  const plan = classes.plans[0];
  if (!plan) return;
  reportOwner(plan.data.constructorUnitId);
  const source = plan.declaration.getSourceFile();
  const site = source.getLineAndCharacterOfPosition(plan.declaration.getStart(source));
  throw new IrUnsupportedError(
    "class-member-unsupported",
    "build",
    `native executable classes need their complete declared JavaScript definition/binding/TDZ/prototype and undefined-field read/type producer (${plan.data.classId} at ${source.fileName}:${site.line + 1}:${site.character + 1}); metadata alone is not semantic preparation`,
  );
}
