// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrIdentityImportedFunctionResolver } from "../ir/imported-functions.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrFunctionMemberClosurePlan, IrFunctionMemberClosures } from "../ir/function-member-closure-plan.js";
import type { IrClosureSignature, IrType, IrTypeRef } from "../ir/nodes.js";
import type { TypeDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { peekFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { noteFunctionValueInhabitant } from "./closures/closure-type-sources.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";

function physicalKey(types: readonly ValType[], result: ValType | null): string {
  return JSON.stringify([types, result]);
}

/**
 * The physical wrapper result of a plan signature: a `val` is its own value
 * type; the logical `string` (a STRING-result plan) is legacy's non-null native
 * string ref, which is also what the IR's canonical string carrier lowers to.
 */
function physicalResult(ctx: CodegenContext, type: IrType | null): ValType | null | undefined {
  if (type === null) return null;
  if (type.kind === "val") return type.val;
  return type.kind === "string" && ctx.nativeStrings ? { kind: "ref", typeIdx: ctx.anyStrTypeIdx } : undefined;
}

/** The allocation's signature is the plan's, up to the string carrier preparation attaches. */
function sameMemberClosureSignature(actual: IrClosureSignature, plan: IrClosureSignature): boolean {
  if (actual === plan) return true;
  return (
    actual.params.length === plan.params.length &&
    actual.params.every((type, index) => type === plan.params[index]) &&
    actual.returnType?.kind === "string" &&
    plan.returnType?.kind === "string"
  );
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
 * (#7106 Stage 4) The OPEN body proof for a VOID- or STRING-result closure:
 * assert.js's `assert.sameValue = function (actual, expected, message) { … }`
 * (oracle `void`, legacy physical result none) and sta.js's
 * `Test262Error.prototype.toString = function () { return … }` (oracle
 * `string`, legacy result the native string ref). The body is NOT restricted to
 * scalar returns (its buildability is the IR selector's own decision, over an
 * empty outer scope); this proof only refuses what would transfer authority the
 * plan does not carry — `super`/`arguments`/`new.target`, a nested function or
 * class (captures), `yield`/`await` — plus `this` unless the plan binds it
 * (`allowThis`), and a `return <value>` unless the ABI has a result
 * (`returnsValue`; a bare `return;` there is refused, it would yield
 * `undefined`). The key records every node plus each identifier's resolved
 * declaration, so `isCurrent` sees a rebinding as staleness.
 */
function openBodyKey(
  expression: ts.FunctionExpression,
  oracle: CodegenContext["oracle"],
  returnsValue: boolean,
  allowThis: boolean,
): string | undefined {
  const facts: Array<string | number> = [];
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    facts.push(node.kind, node.pos, node.end);
    if (
      (node.kind === ts.SyntaxKind.ThisKeyword && !allowThis) ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      ts.isMetaProperty(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassLike(node) ||
      ts.isYieldExpression(node) ||
      ts.isAwaitExpression(node) ||
      (ts.isReturnStatement(node) && (node.expression !== undefined) !== returnsValue)
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

/** Does `expression`'s own body (no nested function, which every plan refuses) read `this`? */
function bodyReadsThis(expression: ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) found = true;
    else ts.forEachChild(node, visit);
  };
  for (const statement of expression.body.statements) visit(statement);
  return found;
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

/** Exact raw-versus-logical adapter proof for one same-source member assignment. */
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
  const assignment = expression.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.right !== expression ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(assignment.left) ||
    assignment.left.questionDotToken ||
    !ts.isIdentifier(assignment.left.name) ||
    !ts.isExpressionStatement(assignment.parent)
  )
    return;
  // `F.x = function …` or the chained `F.p.x = function …`
  // (`Test262Error.prototype.toString = …`, the store #7106 census arm 3 lowers).
  const holder = assignment.left.expression;
  const receiver = ts.isIdentifier(holder)
    ? holder
    : ts.isPropertyAccessExpression(holder) &&
        !holder.questionDotToken &&
        ts.isIdentifier(holder.name) &&
        ts.isIdentifier(holder.expression)
      ? holder.expression
      : undefined;
  if (!receiver) return;
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
  const target = resolver.resolveTopLevelFunctionValueTarget(receiver);
  const source = expression.getSourceFile();
  if (
    !target ||
    target.legacyProjection !== "unambiguous" ||
    target.declaration.getSourceFile() !== source ||
    identity.declarationByUnitId.get(target.targetUnitId) !== target.declaration ||
    ctx.reassignedFunctionDeclarations?.has(target.declaration)
  )
    return;
  const sourceUnitId = identity.unitIdByDeclaration.get(expression);
  const sourceUnit = sourceUnitId === undefined ? undefined : identity.unitByUnitId.get(sourceUnitId);
  const ownerUnitId = ownerDeclaration
    ? identity.unitIdByDeclaration.get(ownerDeclaration)
    : identity.moduleInitUnitIdBySourceFile.get(source);
  if (
    !sourceUnitId ||
    !sourceUnit ||
    sourceUnit.terminal ||
    sourceUnit.kind !== "function-expression" ||
    !ownerUnitId ||
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
  // (#7106 Stage 4) A STRING result (`return "Test262Error: " + this.message;`):
  // legacy registers the native string ref, which the IR's string carrier is.
  const returnsString = oracleSignature?.returns.kind === "string";
  if (
    !oracleSignature ||
    oracleSignature.declaredArity !== expression.parameters.length ||
    oracleSignature.params.length !== expression.parameters.length ||
    (oracleSignature.returns.kind !== "boolean" && !returnsVoid && !returnsString)
  )
    return;
  const physical = operations.computeSignature(expression);
  const result = physical.returnType;
  if (
    physical.hasRestParam ||
    physical.params.length !== expression.parameters.length ||
    (returnsVoid
      ? result !== null
      : returnsString
        ? !ctx.nativeStrings || result?.kind !== "ref" || result.typeIdx !== ctx.anyStrTypeIdx
        : result?.kind !== "i32")
  )
    return;
  // (#7106 Stage 4) A prototype method of an approved fnctor stays legacy's:
  // legacy pins its `this` to the fnctor struct and may build a typed-`this`
  // twin plus direct-call trampolines for it (#3683), none of which the IR does.
  // Without the query (a bare service bundle), a chained `F.p.x` store is refused.
  const fnctorStruct = operations.fnctorPrototypeMethodStruct
    ? operations.fnctorPrototypeMethodStruct(expression)
    : holder !== receiver
      ? "unknown"
      : undefined;
  if (fnctorStruct !== undefined) return;
  // Otherwise `this` is bound once at entry through `dyn.current_this` —
  // legacy's lifted-closure `__current_this` ladder — in an open-body plan.
  const readsThis = bodyReadsThis(expression);
  if (readsThis && !returnsVoid && !returnsString) return;
  const thisStrict = readsThis ? isStrictFunction(expression, ctx.inferModuleStrictArguments) : undefined;
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
    returnsVoid || returnsString
      ? openBodyKey(expression, ctx.oracle, returnsString, readsThis)
      : closedScalarBodyKey(expression, ctx.oracle, parameters);
  const bodyKey = bodyKeyOf();
  if (bodyKey === undefined) return;
  const sourceText = source.text;
  const syntaxIsCurrent = captureMemberClosureSyntax(expression);
  const memberName = access.name;
  const memberText = memberName.text;
  // A string result is the logical `string`: Program-ABI preparation attaches
  // the canonical carrier, which lowers to exactly legacy's `(ref $AnyString)`.
  const signature: IrClosureSignature = Object.freeze({
    params: Object.freeze(physical.params.map((type) => operations.valueType(Object.freeze({ ...type })))),
    returnType:
      physical.returnType === null
        ? null
        : returnsString
          ? Object.freeze({ kind: "string" as const })
          : operations.valueType(Object.freeze({ ...physical.returnType })),
  });
  const key = physicalKey(physical.params, physical.returnType);
  return Object.freeze({
    expression,
    ownerUnitId,
    sourceUnitId,
    signature,
    dynamicParameterIndices,
    ...(thisStrict === undefined ? {} : { thisStrict }),
    isCurrent() {
      // Refuse stale captured source/target before invoking canonical ABI services.
      if (
        expression.parent !== assignment ||
        assignment.right !== expression ||
        assignment.left !== access ||
        access.expression !== holder ||
        (holder !== receiver && (holder as ts.PropertyAccessExpression).expression !== receiver) ||
        source.text !== sourceText ||
        access.name !== memberName ||
        memberName.text !== memberText ||
        !syntaxIsCurrent() ||
        parameterNames.some(
          ([parameter, name, text], index) =>
            expression.parameters[index] !== parameter || parameter.name !== name || name.text !== text,
        )
      )
        return false;
      const currentTarget = resolver.resolveTopLevelFunctionValueTarget(receiver);
      if (
        !currentTarget ||
        currentTarget.declaration !== target.declaration ||
        currentTarget.targetUnitId !== target.targetUnitId
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
        assignment.left !== access ||
        access.name !== memberName ||
        memberName.text !== memberText ||
        current.ownerUnitId !== ownerUnitId ||
        current.sourceUnitId !== sourceUnitId ||
        resolver.resolveTopLevelFunctionValueTarget(receiver)?.declaration !== target.declaration ||
        bodyKeyOf() !== bodyKey ||
        current.thisStrict !== thisStrict ||
        current.dynamicParameterIndices.size !== dynamicParameterIndices.size ||
        [...dynamicParameterIndices].some((index) => !current.dynamicParameterIndices.has(index))
      )
        return false;
      const currentParams = current.signature.params;
      const currentResult = physicalResult(ctx, current.signature.returnType);
      return (
        currentParams.every((type) => type.kind === "val") &&
        currentResult !== undefined &&
        physicalKey(
          currentParams.map((type) => (type as Extract<typeof type, { kind: "val" }>).val),
          currentResult,
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
  /**
   * (#7106 Stage 4) The `$__fnctor_F` struct legacy pins a prototype method's
   * `this` to (`resolveLiftedMethodThisStruct`), injected so this planner
   * stays outside the fnctor-gate import cycle.
   */
  fnctorPrototypeMethodStruct?(expression: ts.FunctionExpression): string | undefined;
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
      if (
        !plan.isCurrent() ||
        !sameMemberClosureSignature(instruction.signature, plan.signature) ||
        instruction.captureFieldTypes.length !== 0
      )
        throw new Error("function-member closure lost its exact source/allocation proof");
      const params = plan.signature.params.map((type) => {
        if (type.kind !== "val") throw new Error("function-member closure has a nonphysical parameter");
        return type.val;
      });
      const result = physicalResult(ctx, plan.signature.returnType);
      if (result === undefined) throw new Error("function-member closure has no physical result");
      const wrapper = peekFuncRefWrapperTypes(ctx, params, result === null ? [] : [result]);
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
