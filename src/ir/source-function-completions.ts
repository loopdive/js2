// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts, assertCurrentProgramSources } from "../ts-api.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { getIrInventoryScannerMetadata } from "./identity.js";
import type { IrUnitId } from "./identity.js";
import type { SourceJsClassDefinitions } from "./source-js-class-definition.js";
import { refuseNativeJsClassSource } from "./source-js-class-lowering.js";
import { preparedIrProgramCallableResults } from "./program-callable-contract.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irDynamic, irVal, type IrType } from "./core/types.js";
import type { IrValueId } from "./core/nodes.js";
import { JS_TAG_IDS } from "./core/js-value-tag-identities.js";
import { IrUnsupportedError } from "./outcomes.js";

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;
interface SourceContext {
  readonly checker: ts.TypeChecker;
  readonly identity: IrPlanningIdentityContext;
  readonly policy: RuntimeManifestPolicy;
}
interface LoweringContext {
  readonly ownerUnitId: IrUnitId;
  readonly identityContext?: IrPlanningIdentityContext;
  readonly checker?: ts.TypeChecker;
  readonly moduleInitUnit?: boolean;
  readonly returnTypeOverride?: IrType | null;
  readonly nativeJsValueCompletion?: ts.FunctionDeclaration;
  readonly nativeJsClassDefinitions?: SourceJsClassDefinitions;
}
interface OrdinaryContract extends SourceContext {
  readonly declaration: ts.FunctionDeclaration;
  readonly result: IrType;
}
// Request-local source contracts only. Every use authenticates the live source again.
const ordinaryContracts = new WeakMap<IrPlanningIdentityContext, Map<ts.FunctionDeclaration, OrdinaryContract>>();
// Results retain only denial membership, never their source/checker context.
const producedResults = new WeakSet<IrType>();
const synchronous = (fn: FunctionNode): boolean =>
  !fn.asteriskToken && !fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
const dynamicResult = (type: IrType | null | undefined): boolean => type?.kind === "dynamic" && type.tag === undefined;
const nativePolicy = (policy: RuntimeManifestPolicy): boolean =>
  policy.target === "standalone" || policy.target === "wasi";

function ownValuedReturns(fn: ts.FunctionDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found = true;
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return found;
}
function authenticate(
  fn: ts.FunctionDeclaration,
  identity: IrPlanningIdentityContext,
  checker: ts.TypeChecker,
  owner?: IrUnitId,
): void {
  const metadata = getIrInventoryScannerMetadata(identity.inventory);
  const unitId = identity.unitIdByDeclaration.get(fn);
  const unit = unitId && identity.unitByUnitId.get(unitId);
  const source = fn.getSourceFile();
  if (
    !metadata ||
    !unitId ||
    !unit ||
    (owner !== undefined && owner !== unitId) ||
    identity.declarationByUnitId.get(unitId) !== fn ||
    identity.sourceFileBySourceId.get(unit.sourceId) !== source ||
    !metadata.units.some((row) => row.declaration === fn && row.record === unit && row.sourceFile === source)
  )
    throw new Error("ordinary completion original source/checker/unit mismatch");
  assertCurrentProgramSources(
    checker,
    metadata.sources.map((row) => row.sourceFile),
    source,
  );
}

export function sourceCompletionSignature(
  declaration: ts.FunctionDeclaration,
  semanticResult: IrType | null,
  context: SourceContext,
  jsClasses?: SourceJsClassDefinitions,
): {
  readonly bodyResult: IrType | null;
  readonly callableResult: IrType | null;
  readonly classValueCompletion: boolean;
} {
  ordinaryContracts.get(context.identity)?.delete(declaration);
  const isAsync = !!declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const classValueCompletion =
    jsClasses !== undefined && semanticResult === null && !isAsync && !declaration.asteriskToken;
  const ordinary =
    nativePolicy(context.policy) &&
    semanticResult === null &&
    synchronous(declaration) &&
    declaration.type?.kind === ts.SyntaxKind.VoidKeyword &&
    ownValuedReturns(declaration);
  const bodyResult: IrType | null = classValueCompletion || ordinary ? { kind: "dynamic" } : semanticResult;
  if (ordinary && !classValueCompletion) {
    authenticate(declaration, context.identity, context.checker);
    let contracts = ordinaryContracts.get(context.identity);
    if (!contracts) ordinaryContracts.set(context.identity, (contracts = new Map()));
    const contract = { ...context, declaration, result: bodyResult! };
    contracts.set(declaration, contract);
    producedResults.add(bodyResult!);
  }
  const callableResults = preparedIrProgramCallableResults({
    funcKind: isAsync ? "async" : "regular",
    resultTypes: bodyResult ? [bodyResult] : [],
  });
  return { bodyResult, callableResult: callableResults[0] ?? null, classValueCompletion };
}

export function classCompletionMode(fn: FunctionNode, options: LoweringContext): boolean {
  const jsValueCompletion = options.nativeJsValueCompletion === fn;
  const isAsync = ts.isFunctionDeclaration(fn) && !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const isGenerator = !!fn.asteriskToken;
  if (
    options.nativeJsValueCompletion !== undefined &&
    (!jsValueCompletion ||
      !ts.isFunctionDeclaration(fn) ||
      !options.nativeJsClassDefinitions ||
      isAsync ||
      isGenerator ||
      options.moduleInitUnit ||
      options.returnTypeOverride?.kind !== "dynamic" ||
      options.returnTypeOverride.tag !== undefined)
  )
    refuseNativeJsClassSource(
      fn,
      "ordinary JavaScript completion requires its original synchronous body and dynamic ABI",
    );
  return jsValueCompletion;
}

export function ordinaryCompletionMode(
  fn: FunctionNode,
  expectedResult: IrType | null,
  options: LoweringContext,
): boolean {
  if (!ts.isFunctionDeclaration(fn) || !options.identityContext) {
    if (expectedResult && producedResults.has(expectedResult))
      throw new Error("ordinary completion result lacks original source owner");
    return false;
  }
  const contract = ordinaryContracts.get(options.identityContext)?.get(fn);
  if (!contract) {
    if (expectedResult && producedResults.has(expectedResult))
      throw new Error("ordinary completion result used by foreign source owner");
    return false;
  }
  if (expectedResult !== contract.result || options.returnTypeOverride !== contract.result)
    throw new Error("ordinary completion source/body result contract changed");
  assertCurrent(fn, options);
  return true;
}
export function assertCurrent(fn: FunctionNode, options: LoweringContext): void {
  if (!ts.isFunctionDeclaration(fn) || !options.identityContext || !options.checker || !options.ownerUnitId)
    throw new Error("ordinary completion original context missing");
  const contract = ordinaryContracts.get(options.identityContext)?.get(fn);
  if (
    !contract ||
    contract.checker !== options.checker ||
    !nativePolicy(contract.policy) ||
    options.moduleInitUnit ||
    !synchronous(fn) ||
    fn.type?.kind !== ts.SyntaxKind.VoidKeyword ||
    !ownValuedReturns(fn) ||
    !dynamicResult(contract.result) ||
    options.returnTypeOverride !== contract.result
  )
    throw new Error("ordinary completion original source contract changed");
  authenticate(fn, options.identityContext, options.checker, options.ownerUnitId);
}

export function ordinaryCompletionValue(
  statement: ts.ReturnStatement,
  builder: IrFunctionBuilder,
  expectedResult: IrType | null,
  raw: IrValueId | undefined,
): IrValueId {
  if (!dynamicResult(expectedResult)) throw new Error("ordinary completion requires actual unrefined dynamic result");
  if (!statement.expression) return builder.emitConst({ kind: "undefined" }, irDynamic(JS_TAG_IDS.Undefined));
  if (raw === undefined) throw new Error("ordinary completion expression did not produce its actual value");
  const actual = builder.typeOf(raw);
  if (actual.kind === "dynamic") return raw;
  if (
    actual.kind === "val" &&
    actual.val.kind === "f64" &&
    actual.typeRef === undefined &&
    !actual.val.undefSentinel &&
    !("symbol" in actual.val)
  )
    return builder.emitBox(raw, irDynamic(JS_TAG_IDS.NumberF64));
  if (
    actual.kind === "val" &&
    actual.val.kind === "i32" &&
    actual.val.boolean === true &&
    !actual.val.symbol &&
    !actual.val.int32 &&
    actual.typeRef === undefined
  )
    return builder.emitBox(raw, irDynamic(JS_TAG_IDS.Boolean));
  const source = statement.getSourceFile(),
    point = source.getLineAndCharacterOfPosition(statement.getStart(source));
  throw new IrUnsupportedError(
    "type-resolution-unsupported",
    "build",
    `ordinary completion ${source.fileName}:${point.line + 1}:${point.character + 1}: actual return carrier is not represented`,
  );
}
export function implicitReturn(builder: IrFunctionBuilder, expectedResult: IrType | null): void {
  if (!dynamicResult(expectedResult)) throw new Error("ordinary completion requires actual unrefined dynamic result");
  const value = builder.emitConst({ kind: "undefined" }, irDynamic(JS_TAG_IDS.Undefined));
  builder.terminate({ kind: "return", values: [value] });
}

export function voidExpressionValue(
  builder: IrFunctionBuilder,
  ordinaryCompletionBuilder: IrFunctionBuilder | undefined,
): IrValueId {
  if (builder === ordinaryCompletionBuilder)
    return builder.emitConst({ kind: "undefined" }, irDynamic(JS_TAG_IDS.Undefined));
  return builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
}
