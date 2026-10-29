// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrIdentityImportedFunctionResolver } from "../ir/imported-functions.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrFunctionMemberClosurePlan, IrFunctionMemberClosures } from "../ir/function-member-closure-plan.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrClosureSignature, IrType, IrTypeRef } from "../ir/nodes.js";
import type { TypeDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { peekFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { noteFunctionValueInhabitant } from "./closures/closure-type-sources.js";

function physicalKey(types: readonly ValType[], result: ValType | null): string {
  return JSON.stringify([types, result]);
}

/** No capture/mutation/implicit receiver authority is transferred by this proof. */
function closedScalarBodyKey(
  expression: ts.FunctionExpression,
  oracle: CodegenContext["oracle"],
  parameters: ReadonlySet<ts.ParameterDeclaration>,
): string | undefined {
  const facts: Array<string | number | boolean> = [];
  const scalar = (node: ts.Expression): boolean => {
    facts.push(node.kind, node.pos, node.end);
    if (ts.isParenthesizedExpression(node)) return scalar(node.expression);
    if (ts.isIdentifier(node)) {
      const declaration = oracle.valueDeclarationOf(node);
      facts.push(node.text);
      return (
        declaration !== undefined &&
        ts.isParameter(declaration) &&
        parameters.has(declaration) &&
        oracle.declarationsOf(node).includes(declaration)
      );
    }
    if (ts.isNumericLiteral(node)) {
      facts.push(node.text);
      return true;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(node)) {
      facts.push(node.operator);
      return (
        (node.operator === ts.SyntaxKind.ExclamationToken ||
          node.operator === ts.SyntaxKind.MinusToken ||
          node.operator === ts.SyntaxKind.PlusToken) &&
        scalar(node.operand)
      );
    }
    if (!ts.isBinaryExpression(node)) return false;
    facts.push(node.operatorToken.kind);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.MinusToken:
        return scalar(node.left) && scalar(node.right);
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return (
          oracle.isBooleanProducing(node.left) &&
          oracle.isBooleanProducing(node.right) &&
          scalar(node.left) &&
          scalar(node.right)
        );
      default:
        return false;
    }
  };
  const statement = (node: ts.Statement): boolean => {
    facts.push(node.kind, node.pos, node.end);
    if (ts.isBlock(node)) return node.statements.every(statement);
    if (ts.isReturnStatement(node)) return node.expression !== undefined && scalar(node.expression);
    return (
      ts.isIfStatement(node) &&
      scalar(node.expression) &&
      statement(node.thenStatement) &&
      (node.elseStatement === undefined || statement(node.elseStatement))
    );
  };
  return expression.body.statements.length > 0 && expression.body.statements.every(statement)
    ? JSON.stringify(facts)
    : undefined;
}

/**
 * (#7106 Stage 4) The VOID-result body proof: assert.js's `assert.sameValue =
 * function (actual, expected, message) { … }` — oracle return `void`, legacy
 * physical result none. The body is NOT restricted to scalar returns (its
 * buildability is the IR selector's own decision, over an empty outer scope);
 * this proof only refuses what would transfer authority the plan does not
 * carry — `this`/`super`/`arguments`/`new.target`, a nested function or class
 * (captures), `yield`/`await` — and a `return <value>` (the ABI has no
 * result). The key records every node plus each identifier's resolved
 * declaration, so `isCurrent` sees a rebinding as staleness.
 *
 * (#7195) `identifierCalls: false` also refuses a bare `f()` / `Symbol()`:
 * a call-argument site brings no callee unit into the component, so
 * `<module-init>` mints no direct-call plan for it and the build would
 * withdraw after the claim.
 */
function openVoidBodyKey(
  expression: ts.FunctionExpression,
  oracle: CodegenContext["oracle"],
  identifierCalls: boolean,
): string | undefined {
  const facts: Array<string | number> = [];
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    facts.push(node.kind, node.pos, node.end);
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      ts.isMetaProperty(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassLike(node) ||
      ts.isYieldExpression(node) ||
      ts.isAwaitExpression(node) ||
      (ts.isReturnStatement(node) && node.expression !== undefined) ||
      (!identifierCalls && ts.isCallExpression(node) && ts.isIdentifier(node.expression))
    ) {
      ok = false;
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "arguments" || node.text === "eval") {
        ok = false;
        return;
      }
      const declaration = oracle.valueDeclarationOf(node);
      facts.push(node.text, declaration === undefined ? -1 : declaration.pos);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of expression.body.statements) visit(statement);
  return ok && expression.body.statements.length > 0 ? JSON.stringify(facts) : undefined;
}

/** Guard cached oracle facts with the exact captured AST before querying them. */
function captureMemberClosureSyntax(expression: ts.FunctionExpression): () => boolean {
  const nodes: Array<{
    readonly node: ts.Node;
    readonly parent: ts.Node;
    readonly kind: ts.SyntaxKind;
    readonly pos: number;
    readonly end: number;
    readonly text: string | undefined;
    readonly prefixOperator: ts.SyntaxKind | undefined;
    readonly children: readonly ts.Node[];
  }> = [];
  const visit = (node: ts.Node): void => {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    nodes.push({
      node,
      parent: node.parent,
      kind: node.kind,
      pos: node.pos,
      end: node.end,
      text: ts.isIdentifier(node) || ts.isNumericLiteral(node) ? node.text : undefined,
      prefixOperator: ts.isPrefixUnaryExpression(node) ? node.operator : undefined,
      children,
    });
    for (const child of children) visit(child);
  };
  visit(expression);
  return () =>
    nodes.every(({ node, parent, kind, pos, end, text, prefixOperator, children }) => {
      if (
        node.parent !== parent ||
        node.kind !== kind ||
        node.pos !== pos ||
        node.end !== end ||
        (ts.isIdentifier(node) || ts.isNumericLiteral(node) ? node.text : undefined) !== text ||
        (ts.isPrefixUnaryExpression(node) ? node.operator : undefined) !== prefixOperator
      )
        return false;
      const current: ts.Node[] = [];
      ts.forEachChild(node, (child) => {
        current.push(child);
      });
      return current.length === children.length && current.every((child, index) => child === children[index]);
    });
}

/**
 * Where the FunctionExpression sits. Its owner unit and the source facts that
 * make the site current; the ABI and body proofs are site-independent.
 */
interface FunctionClosureSite {
  readonly kind: IrFunctionMemberClosurePlan["site"];
  readonly ownerUnitId: IrUnitId;
  isCurrent(): boolean;
}

/** The exact same-source top-level function a receiver identifier names, or `undefined`. */
function sameSourceFunctionTarget(
  ctx: CodegenContext,
  identity: IrPlanningIdentityContext,
  resolver: IrIdentityImportedFunctionResolver,
  receiver: ts.Identifier,
): ReturnType<IrIdentityImportedFunctionResolver["resolveTopLevelFunctionValueTarget"]> {
  const target = resolver.resolveTopLevelFunctionValueTarget(receiver);
  return target &&
    target.legacyProjection === "unambiguous" &&
    target.declaration.getSourceFile() === receiver.getSourceFile() &&
    identity.declarationByUnitId.get(target.targetUnitId) === target.declaration &&
    !ctx.reassignedFunctionDeclarations?.has(target.declaration)
    ? target
    : undefined;
}

/** The receiver still names the same top-level function unit. */
function sameTargetAgain(
  resolver: IrIdentityImportedFunctionResolver,
  receiver: ts.Identifier,
  target: NonNullable<ReturnType<typeof sameSourceFunctionTarget>>,
): boolean {
  const current = resolver.resolveTopLevelFunctionValueTarget(receiver);
  return current?.declaration === target.declaration && current.targetUnitId === target.targetUnitId;
}

/** `F.member = function () {}` at the top level or directly in a top-level function body. */
function memberAssignmentSite(
  ctx: CodegenContext,
  identity: IrPlanningIdentityContext,
  resolver: IrIdentityImportedFunctionResolver,
  expression: ts.FunctionExpression,
): FunctionClosureSite | undefined {
  const assignment = expression.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.right !== expression ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(assignment.left) ||
    assignment.left.questionDotToken ||
    !ts.isIdentifier(assignment.left.expression) ||
    !ts.isIdentifier(assignment.left.name) ||
    !ts.isExpressionStatement(assignment.parent)
  )
    return;
  const statementOwner = assignment.parent.parent;
  const ownerDeclaration =
    ts.isBlock(statementOwner) &&
    ts.isFunctionDeclaration(statementOwner.parent) &&
    statementOwner.parent.body === statementOwner &&
    ts.isSourceFile(statementOwner.parent.parent)
      ? statementOwner.parent
      : undefined;
  if (!ts.isSourceFile(statementOwner) && !ownerDeclaration) return;
  const access = assignment.left;
  const receiver = assignment.left.expression;
  const memberName = access.name;
  const memberText = memberName.text;
  const target = sameSourceFunctionTarget(ctx, identity, resolver, receiver);
  const ownerUnitId = ownerDeclaration
    ? identity.unitIdByDeclaration.get(ownerDeclaration)
    : identity.moduleInitUnitIdBySourceFile.get(expression.getSourceFile());
  if (!target || !ownerUnitId) return;
  return {
    kind: "member-assignment",
    ownerUnitId,
    isCurrent: () =>
      expression.parent === assignment &&
      assignment.right === expression &&
      assignment.left === access &&
      access.expression === receiver &&
      access.name === memberName &&
      memberName.text === memberText &&
      sameTargetAgain(resolver, receiver, target),
  };
}

/**
 * (#7195) `F.m(…, function () {}, …)` as a top-level statement: the closure is
 * boxed into the dynamic carrier at a call through a same-source function
 * object's member, whose callee dispatches it by the canonical wrapper type.
 * Standalone target only: the WASI module-init route is unmeasured, and the
 * native-first gc lane (which also runs the standalone regime) keeps its output
 * unchanged.
 */
function callArgumentSite(
  ctx: CodegenContext,
  identity: IrPlanningIdentityContext,
  resolver: IrIdentityImportedFunctionResolver,
  expression: ts.FunctionExpression,
): FunctionClosureSite | undefined {
  const call = expression.parent;
  if (
    ctx.targetProfile.target !== "standalone" ||
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    !ts.isIdentifier(call.expression.expression) ||
    !ts.isExpressionStatement(call.parent) ||
    !ts.isSourceFile(call.parent.parent)
  )
    return;
  const index = call.arguments.indexOf(expression);
  const callee = call.expression;
  const receiver = call.expression.expression;
  const target = sameSourceFunctionTarget(ctx, identity, resolver, receiver);
  const ownerUnitId = identity.moduleInitUnitIdBySourceFile.get(expression.getSourceFile());
  if (index < 0 || !target || !ownerUnitId) return;
  return {
    kind: "call-argument",
    ownerUnitId,
    isCurrent: () =>
      expression.parent === call &&
      call.arguments[index] === expression &&
      call.expression === callee &&
      callee.expression === receiver &&
      sameTargetAgain(resolver, receiver, target),
  };
}

/** Exact raw-versus-logical adapter proof for one same-source member assignment or call argument. */
function planMemberClosure(
  ctx: CodegenContext,
  identity: IrPlanningIdentityContext,
  resolver: IrIdentityImportedFunctionResolver,
  expression: ts.FunctionExpression,
  operations: FunctionMemberClosureOperations,
): IrFunctionMemberClosurePlan | undefined {
  if (
    identity.sourceFileBySourceId.size !== 1 ||
    ctx.fast ||
    !operations.dynamicCarrierIsExternref() ||
    ctx.targetProfile.semanticProviders !== "native-first" ||
    !(ctx.standalone || ctx.wasi) ||
    ctx.runtimeEvalGlobalFunctionBindings === true ||
    expression.name ||
    expression.type ||
    expression.asteriskToken ||
    expression.typeParameters?.length ||
    expression.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    (expression as { symbol?: ts.Symbol }).symbol === undefined
  )
    return;
  const site =
    memberAssignmentSite(ctx, identity, resolver, expression) ?? callArgumentSite(ctx, identity, resolver, expression);
  if (!site) return;
  const ownerUnitId = site.ownerUnitId;
  const source = expression.getSourceFile();
  const sourceUnitId = identity.unitIdByDeclaration.get(expression);
  const sourceUnit = sourceUnitId === undefined ? undefined : identity.unitByUnitId.get(sourceUnitId);
  if (
    !sourceUnitId ||
    !sourceUnit ||
    sourceUnit.terminal ||
    sourceUnit.kind !== "function-expression" ||
    sourceUnit.terminalOwnerId !== ownerUnitId ||
    sourceUnit.lexicalOwnerId !== ownerUnitId ||
    identity.declarationByUnitId.get(sourceUnitId) !== expression ||
    identity.sourceFileBySourceId.get(sourceUnit.sourceId) !== source
  )
    return;
  // Facts belong to this exact inventoried FunctionExpression. Its actual
  // parameter declaration joins and canonical physical ABI are checked below;
  // no declaration identity is invented from the registry-free signature fact.
  const oracleSignature = ctx.oracle.signatureOf(expression);
  // A throw-only body (`Test262Error.thrower = function (message) { throw … }`)
  // has the oracle return `never`, reported unresolvable; legacy still
  // registers it with no physical result, and the void body proof refuses
  // any `return <value>`.
  const returnsVoid = oracleSignature?.returns.kind === "void" || oracleSignature?.returns.kind === "unresolvable";
  if (
    !oracleSignature ||
    oracleSignature.declaredArity !== expression.parameters.length ||
    oracleSignature.params.length !== expression.parameters.length ||
    (oracleSignature.returns.kind !== "boolean" && !returnsVoid) ||
    (site.kind === "call-argument" && (!returnsVoid || expression.parameters.length !== 0))
  )
    return;
  const physical = operations.computeSignature(expression);
  if (
    physical.hasRestParam ||
    physical.params.length !== expression.parameters.length ||
    (returnsVoid ? physical.returnType !== null : physical.returnType?.kind !== "i32")
  )
    return;
  const parameters = new Set<ts.ParameterDeclaration>();
  const seenNames = new Set<string>();
  const parameterNames: Array<readonly [ts.ParameterDeclaration, ts.Identifier, string]> = [];
  const dynamicParameterIndices = new Set<number>();
  for (let index = 0; index < expression.parameters.length; index++) {
    const parameter = expression.parameters[index]!;
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.type ||
      parameter.initializer ||
      parameter.questionToken ||
      parameter.dotDotDotToken ||
      parameter.name.text === "this" ||
      parameter.name.text === "arguments" ||
      ts.getJSDocType(parameter)
    )
      return;
    if (
      ctx.oracle.valueDeclarationOf(parameter.name) !== parameter ||
      !ctx.oracle.declarationsOf(parameter.name).includes(parameter) ||
      seenNames.has(parameter.name.text)
    )
      return;
    parameters.add(parameter);
    seenNames.add(parameter.name.text);
    parameterNames.push([parameter, parameter.name, parameter.name.text]);
    const actual = ctx.oracle.typeFactOf(parameter.name);
    const signatureFact = oracleSignature.params[index]!;
    if (signatureFact.kind !== actual.kind) return;
    const slot = physical.params[index]!;
    if (actual.kind === "any" && slot.kind === "externref") dynamicParameterIndices.add(index);
    else if (!(actual.kind === "number" && slot.kind === "f64") && !(actual.kind === "boolean" && slot.kind === "i32"))
      return;
  }
  const bodyKeyOf = (): string | undefined =>
    returnsVoid
      ? openVoidBodyKey(expression, ctx.oracle, site.kind === "member-assignment")
      : closedScalarBodyKey(expression, ctx.oracle, parameters);
  const bodyKey = bodyKeyOf();
  if (bodyKey === undefined) return;
  const sourceText = source.text;
  const syntaxIsCurrent = captureMemberClosureSyntax(expression);
  const signature: IrClosureSignature = Object.freeze({
    params: Object.freeze(physical.params.map((type) => operations.valueType(Object.freeze({ ...type })))),
    returnType: physical.returnType === null ? null : operations.valueType(Object.freeze({ ...physical.returnType })),
  });
  const key = physicalKey(physical.params, physical.returnType);
  return Object.freeze({
    expression,
    ownerUnitId,
    sourceUnitId,
    site: site.kind,
    signature,
    dynamicParameterIndices,
    isCurrent() {
      // Refuse stale captured source/target before invoking canonical ABI services.
      if (
        source.text !== sourceText ||
        !site.isCurrent() ||
        !syntaxIsCurrent() ||
        parameterNames.some(
          ([parameter, name, text], index) =>
            expression.parameters[index] !== parameter || parameter.name !== name || name.text !== text,
        )
      )
        return false;
      const current = planMemberClosure(ctx, identity, resolver, expression, operations);
      if (
        !current ||
        parameterNames.some(
          ([parameter, name, text], index) =>
            expression.parameters[index] !== parameter ||
            parameter.name !== name ||
            name.text !== text ||
            ctx.oracle.valueDeclarationOf(name) !== parameter ||
            !ctx.oracle.declarationsOf(name).includes(parameter),
        ) ||
        source.text !== sourceText ||
        !site.isCurrent() ||
        current.ownerUnitId !== ownerUnitId ||
        current.sourceUnitId !== sourceUnitId ||
        bodyKeyOf() !== bodyKey ||
        current.dynamicParameterIndices.size !== dynamicParameterIndices.size ||
        [...dynamicParameterIndices].some((index) => !current.dynamicParameterIndices.has(index))
      )
        return false;
      const currentParams = current.signature.params;
      const currentResult = current.signature.returnType;
      return (
        currentParams.every((type) => type.kind === "val") &&
        (currentResult === null || currentResult.kind === "val") &&
        physicalKey(
          currentParams.map((type) => (type as Extract<typeof type, { kind: "val" }>).val),
          currentResult === null ? null : currentResult.val,
        ) === key
      );
    },
  });
}

export interface FunctionMemberClosureServices {
  computeSignature(expression: ts.FunctionExpression): {
    params: ValType[];
    returnType: ValType | null;
    hasRestParam: boolean;
  };
  dynamicCarrierIsExternref(): boolean;
}
interface FunctionMemberClosureOperations extends FunctionMemberClosureServices {
  valueType(type: ValType): IrType;
  typeBindingKey(binding: IrTypeRef["binding"]): string;
}

/** Per-compilation source sidecar. No new runtime registry or wrapper allocation. */
export function makeIrFunctionMemberClosures(
  ctx: CodegenContext,
  identity: IrPlanningIdentityContext,
  resolver: IrIdentityImportedFunctionResolver,
  operations: FunctionMemberClosureOperations,
): IrFunctionMemberClosures {
  const byExpression = new Map<ts.FunctionExpression, IrFunctionMemberClosurePlan>();
  const byUnit = new Map<import("../ir/identity.js").IrUnitId, IrFunctionMemberClosurePlan>();
  return {
    resolve(expression) {
      const cached = byExpression.get(expression);
      if (cached) return cached.isCurrent() ? cached : undefined;
      const plan = planMemberClosure(ctx, identity, resolver, expression, operations);
      if (plan) {
        byExpression.set(expression, plan);
        byUnit.set(plan.sourceUnitId, plan);
      }
      return plan;
    },
    notePreparedAllocation(instruction, refs) {
      if (instruction.liftedFunc.binding.kind !== "unit") return;
      const plan = byUnit.get(instruction.liftedFunc.binding.unitId);
      if (!plan) return;
      if (!plan.isCurrent() || instruction.signature !== plan.signature || instruction.captureFieldTypes.length !== 0)
        throw new Error("function-member closure lost its exact source/allocation proof");
      const params = plan.signature.params.map((type) => {
        if (type.kind !== "val") throw new Error("function-member closure has a nonphysical parameter");
        return type.val;
      });
      const result = plan.signature.returnType;
      if (result !== null && result.kind !== "val") throw new Error("function-member closure has no physical result");
      const wrapper = peekFuncRefWrapperTypes(ctx, params, result === null ? [] : [result.val]);
      const actual = ctx.irUnitFuncMap.get(plan.sourceUnitId);
      const session = ctx.programAbiSession;
      if (
        !wrapper ||
        !actual ||
        actual.typeIdx !== wrapper.funcTypeIdx ||
        !refs ||
        !session ||
        !ctx.mod.functions.includes(actual)
      )
        throw new Error("function-member closure has no exact prepared wrapper/source slot");
      const hasObject = (type: TypeDef | undefined): boolean => {
        if (!type) return false;
        const cell = session.typeCellFor(type);
        return (
          cell !== undefined &&
          cell.current === type &&
          refs.some(
            (ref) =>
              session.hasLocator(ref.binding.bindingId, cell) &&
              session.locatorObjectForBinding(ref.binding.bindingId) === cell &&
              session.getDraft(ref.binding.bindingId)?.structuralReferenceKey ===
                operations.typeBindingKey(ref.binding),
          )
        );
      };
      if (!hasObject(ctx.mod.types[wrapper.structTypeIdx]!) || !hasObject(ctx.mod.types[actual.typeIdx]!))
        throw new Error("function-member closure prepared type evidence is missing or ambiguous");
      noteFunctionValueInhabitant(ctx, wrapper.structTypeIdx, plan.expression);
    },
  };
}
