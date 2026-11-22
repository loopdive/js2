// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Where the Prepared source producer admits TypeScript's `any` as the logical
 * dynamic value, and with which carrier.
 *
 * - Host async frames keep a JS value across `await` (identity transport,
 *   physically the host's `externref`).
 * - (#7354 D1) Internal synchronous functions on standalone WasmGC take and
 *   return an explicitly annotated `any`: the dynamic-value legalization lowers
 *   it to the native `externref` carrier. An exported `any` is a host boundary
 *   and keeps its existing contract (the Boolean `any` result, or a refusal).
 * - (#7354 P) On that lane a parameter without a TypeScript annotation is the
 *   dynamic value too. Nothing checks an untyped or JSDoc-typed parameter at
 *   runtime, and its callers include top-level code, calls with missing
 *   arguments and calls through values, so no call-site type is a contract.
 *   An unannotated result is dynamic where the checker cannot vouch for the
 *   value the body returns: it is `any`, or the body can also run off its end
 *   (that path returns `undefined`). Other unannotated results keep the
 *   producer's inference, which the middle end checks against the lowered
 *   body. Either contract triggers the legalization below like an explicit
 *   `any`.
 * - (#7354 H) On that lane a script `var` without a proven typed home lives in
 *   the carrier whatever the checker infers for it, so "the checker cannot
 *   vouch" also covers every value read from such a home and passed on
 *   unchanged (`source-dynamic-provenance.ts`). The producer asks all of these
 *   through one {@link ProgramDynamicContracts} per program, so the home, the
 *   result contracts and the flow rule answer from the same provenance.
 */
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import type { IrFunction } from "./core/nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { ownRefusal } from "./abort-bodies.js";
import type { IrUnitId } from "./identity.js";
import {
  DynamicValueGap,
  legalizeDynamicValues,
  refuseUnadmittedThrows,
} from "./program/dynamic-value-legalization.js";
import { legalizeDynamicAllocations } from "./program/dynamic-carrier-types.js";
import { retargetNumberToString } from "./program/number-to-string-target.js";
import { programObjects } from "./source-plain-objects.js";
import { objectStaticOperand } from "./realm-static-call.js";
import { pristineBuiltinGlobal } from "./builtin-global-binding.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";
import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";
import { functionBodyAlwaysTerminates, irFunctionBodyReturnsValue } from "./select.js";
import { someReturnedValue } from "./function-returns.js";
import {
  sourceDynamicProvenance,
  sourceFunctionCallee,
  type SourceDynamicProvenance,
} from "./source-dynamic-provenance.js";
import { syntacticAnnotation } from "./select-expression-structure.js";
import { isUndeclaredInFile } from "../shared/ambient-intrinsics.js";
import { isTopLevelStatementDeclaration } from "../shared/var-declaration-lists.js";
import { bindingHoldsItsDeclaration } from "../shared/binding-holds-declaration.js";
import { ownedByDescriptorLiteral } from "./ordinary-object-closure-signatures.js";
import { functionDeclarationsReadAsValues } from "./function-declaration-values.js";
import type { CodeStrictness } from "./from-ast.js";
import { readsAmbientThisGlobal } from "../shared/body-references-own-this.js";

type Carries = SourceDynamicProvenance["carries"];
type Signature = { readonly params: readonly IrType[]; readonly returnType: IrType | null };
/** A program global as the source producer holds it: only its storage type matters here. */
type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target" | "stringConst">;
type DynamicLane = "host-async" | "native" | undefined;
const DYNAMIC: IrType = Object.freeze({ kind: "dynamic" });
const IR_BOOLEAN_RESULT: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

/** The scalar a number, boolean or string checker type lowers to. */
export function checkerScalar(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "val", val: { kind: "f64" } };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "val", val: { kind: "i32", boolean: true } };
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
  return undefined;
}

function annotatedAny(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): boolean {
  return annotation !== undefined && checker.getTypeFromTypeNode(annotation) === checker.getAnyType();
}

/**
 * A value an unannotated body returns that the checker cannot vouch for: the checker says `any`, the body can
 * also run off its end, which returns `undefined`, or (#7354 H) a returned value may be the dynamic value
 * whatever the checker infers for it. A JSDoc `@returns` adds no arm: where the checker reads it, it is the
 * returned value's contextual type, so a value that may be dynamic meets the implicit-flow rule at the `return`
 * (or, under #7354 H, makes the result dynamic, which from-ast refuses against the tag); where the checker does
 * not attach it to the declaration, the result is typed from the body.
 */
function uncheckedResult(body: ts.Block, checkerSaysAny: boolean, carries: Carries): boolean {
  return (
    irFunctionBodyReturnsValue(body) &&
    (checkerSaysAny || !functionBodyAlwaysTerminates(body) || someReturnedValue(body, carries))
  );
}

function hostPromiseFulfillment(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const ambient = checker.resolveName("Promise", undefined, ts.SymbolFlags.Type, false);
  if (
    !ambient?.declarations?.length ||
    !ambient.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  )
    return undefined;
  // Checking the resolved symbol admits aliases, but not source classes or structural thenables.
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.getSymbol() !== ambient) return undefined;
  const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
  return arguments_.length === 1 ? arguments_[0] : undefined;
}

/**
 * The lane of `declaration`'s contracts. The native lane is for functions no host calls: an `export` modifier
 * (also `export default`) leaves it here. A function exported by name (`export { f }`) keeps the native
 * contract, and the presentation's export join refuses it, since its slots are not the host's.
 */
function dynamicLane(policy: SourcePolicy, declaration: ts.FunctionDeclaration | undefined): DynamicLane {
  if (policy.backend !== "wasmgc") return undefined;
  const has = (kind: ts.SyntaxKind) => declaration?.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
  if (has(ts.SyntaxKind.AsyncKeyword)) return policy.target === "host" ? "host-async" : undefined;
  return policy.target === "standalone" && !has(ts.SyntaxKind.ExportKeyword) ? "native" : undefined;
}

/**
 * The dynamic (or host Promise) contract of a parameter, if its lane admits one; natively also an unannotated one.
 * (#7354 W2) Only a syntactic annotation types a parameter natively (`syntacticAnnotation`): under a JSDoc `@param`
 * it holds the dynamic value whatever the checker reads from the tag. Provenance asks it of a parameter read.
 */
function sourceDynamicParameter(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
): IrType | undefined {
  const lane = dynamicLane(policy, declaration);
  const annotation = syntacticAnnotation(parameter);
  if (annotation === undefined) return lane === "native" ? { kind: "dynamic" } : undefined;
  if (annotatedAny(checker, annotation)) return lane ? checkerAny(checker, parameter.name) : undefined;
  if (lane !== "host-async") return undefined;
  // Preserve logical any independently of a typed Promise's host callable carrier.
  for (const type of [checker.getTypeFromTypeNode(annotation), checker.getTypeAtLocation(parameter.name)]) {
    const fulfillment = hostPromiseFulfillment(checker, type);
    if (!fulfillment || (fulfillment.flags & ts.TypeFlags.NumberLike) === 0) return undefined;
  }
  return { kind: "val", val: { kind: "externref" } };
}

/**
 * The dynamic result contract: `Promise<any>` on a host async frame; natively an annotated `any`, or an
 * unannotated result the checker cannot vouch for.
 */
function sourceDynamicResult(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration,
  carries: Carries,
): IrType | undefined {
  const lane = dynamicLane(policy, declaration);
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!lane || !signature) return undefined;
  const any = checker.getAnyType();
  const result = checker.getReturnTypeOfSignature(signature);
  if (lane === "native") {
    // The producer refuses a declaration without a body before it asks for a contract.
    const annotation = syntacticAnnotation(declaration);
    const dynamic = annotation
      ? annotatedAny(checker, annotation) && result === any
      : uncheckedResult(declaration.body!, result === any, carries);
    return dynamic ? { kind: "dynamic" } : undefined;
  }
  if (hostPromiseFulfillment(checker, result) !== any) return undefined;
  if (declaration.type && hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== any)
    return undefined;
  return { kind: "dynamic" };
}

/**
 * (#7354 T/X review) Natively an unannotated result the checker types Boolean, and that is not dynamic, is the
 * Boolean carrier: the propagated result (shared with the ordinary pipeline) lowers it to a plain `i32`, which the
 * presentation's source-declaration join refuses (`return e === 3`, `return 1 === 1` in a parameterless function).
 */
function sourceBooleanResult(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration,
): IrType | undefined {
  const signature = checker.getSignatureFromDeclaration(declaration);
  return dynamicLane(policy, declaration) === "native" &&
    declaration.type === undefined &&
    signature !== undefined &&
    (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.BooleanLike) !== 0
    ? IR_BOOLEAN_RESULT
    : undefined;
}

/**
 * (#7354 Fa) A function expression whose parameters and result carry no TypeScript annotation is a function value
 * with P's all-dynamic signature on the native lane: every parameter and the result are the dynamic value. Its
 * callers include calls through values (`js.closure.call:N` passes and returns the carrier), so, as for an
 * unannotated declaration's parameters, no call site types it. A parameter list with a default, a rest element or
 * a pattern, and a generator or async literal, have no such contract. (#7354 O2) An object literal's `get` / `set`
 * accessor is such a value too (the realm calls it through the dispatcher, a program reads it through
 * `Object.getOwnPropertyDescriptor`), and so is a function expression inside such a literal, both on the lane of
 * their enclosing function declaration: in an exported one (a typed #3518 program) they keep the checker's
 * signature ({@link ownedByDescriptorLiteral}).
 */
function sourceDynamicClosureSignature(
  policy: SourcePolicy,
  expression: ts.FunctionLikeDeclaration,
): { readonly params: readonly IrType[]; readonly returnType: IrType } | undefined {
  const descriptorLiteral = ts.isAccessor(expression) || ownedByDescriptorLiteral(expression);
  if (
    !nativeDynamicLane(policy) ||
    !(ts.isFunctionExpression(expression) || ts.isAccessor(expression)) ||
    (descriptorLiteral &&
      dynamicLane(policy, ts.findAncestor(expression.parent, ts.isFunctionDeclaration)) !== "native") ||
    expression.type !== undefined ||
    expression.asteriskToken !== undefined ||
    expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    expression.parameters.some(
      (parameter) =>
        parameter.type !== undefined ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined ||
        parameter.questionToken !== undefined ||
        !ts.isIdentifier(parameter.name),
    )
  )
    return undefined;
  return { params: expression.parameters.map(() => DYNAMIC), returnType: DYNAMIC };
}

/**
 * (#7354 Fa) A script `var` that holds its function-expression initializer from its declaration on: a top-level
 * statement's declarator of the program's only source, whose binding nothing else writes
 * (`bindingHoldsItsDeclaration`; an Annex B block-level function of the same name is a second binding site, so it
 * declines too). from-ast keeps the closure on the binding's module-init scope entry when it lowers the store, so
 * only module-init code after the declaration, outside every function, sees it: there the slot holds exactly that
 * closure, and a call through the name is the closure's direct call.
 */
function staticFunctionValue(
  policy: SourcePolicy,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.VariableDeclaration,
): boolean {
  const { name, initializer } = declaration;
  if (
    sourceFiles.length !== 1 ||
    !initializer ||
    !ts.isFunctionExpression(initializer) ||
    !sourceDynamicClosureSignature(policy, initializer) ||
    !isTopLevelStatementDeclaration(declaration) ||
    !ts.isIdentifier(name)
  )
    return false;
  return bindingHoldsItsDeclaration(name, declaration);
}

/** The lane has the native dynamic carrier (wasmgc standalone). */
export function nativeDynamicLane(policy: SourcePolicy): boolean {
  return dynamicLane(policy, undefined) === "native";
}

/** (#7354 H) The dynamic-value contracts of one program's sources, over its provenance. */
export interface ProgramDynamicContracts extends SourceDynamicProvenance {
  /** (#7354 F1b) The top-level function declarations read as values (`function-declaration-values.ts`). */
  readonly functionDeclarationValues: readonly ts.FunctionDeclaration[];
  /** The dynamic (or host Promise) contract of a parameter of `declaration`, if any. */
  readonly parameter: (declaration: ts.FunctionDeclaration, parameter: ts.ParameterDeclaration) => IrType | undefined;
  /** The dynamic result contract of `declaration`, or natively its Boolean carrier, if any. */
  readonly result: (declaration: ts.FunctionDeclaration) => IrType | undefined;
  /**
   * An unannotated result typed by the ordinary pipeline's propagation (`propagated`). Where it has no type, the
   * result is void when the body returns no value, else a refusal naming the checker's type (`return n as
   * unknown`) rather than a void result a call would trip over later.
   */
  readonly propagatedResult: (
    declaration: ts.FunctionDeclaration,
    propagated: IrType | null | undefined,
  ) => IrType | null;
  /**
   * from-ast lowers a dynamic value only where the lane has its carrier. (#7354 T) That carrier is the raw
   * `externref`: `null` is its null reference (from-ast's dynamic `null` literal and `=== null` test), and a
   * catch binding reads the exception payload as the dynamic value (provenance models it: a local without an
   * initializer). Invariant: every payload that can reach a catch is in the admitted set (a dynamic value, a boxed
   * number, `null`) or an Error object, for which every dynamic operation is exact too. A string, Boolean or object
   * throw, a TDZ ReferenceError and the runtime's null-vector throw (`ref.null extern`, which would read as `null`)
   * all refuse before a catch today; the slice that makes one reachable updates
   * tests/issue-7354-x-dynamic-throw.test.ts, which pins each.
   */
  readonly resolver: {
    readonly resolveDynamic?: () => ValType;
    readonly dynamicCarrierIsExternref?: () => boolean;
    readonly unresolvedNameIsAbsent?: (node: ts.Identifier) => boolean;
    /** (#7354 Fa) The all-dynamic signature of an unannotated function expression, if the lane admits one. */
    readonly dynamicClosureSignature?: (expression: ts.FunctionLikeDeclaration) => Signature | undefined;
    /** (#7354 Fa) {@link staticFunctionValue}. */
    readonly staticFunctionValue?: (declaration: ts.VariableDeclaration) => boolean;
    /** (#7354 F1b) Closures are function objects (`function-object-lowering.ts`). */
    readonly createsFunctionObjects?: () => boolean;
    /** (#7354 O1) `pristineBuiltinGlobal`: the identifier reads the unchanged global built-in of its name. */
    readonly isPristineBuiltinGlobal?: (identifier: ts.Identifier) => boolean;
    /**
     * (#7354 C2) Some function expression binds its own `this` (`closureCodeStrictness`): a direct call of a closure
     * installs no receiver, so then every call of a closure value is the dispatcher's, which installs one.
     */
    readonly closuresBindReceivers?: () => boolean;
    /** (#7354 C2) {@link ProgramDynamicContracts.codeStrictness} of a function expression. */
    readonly closureCodeStrictness?: CodeStrictness;
  };
  /**
   * (#7260) The strictness of a function's or a script's code (`functionCodeStrict`), and (#7354 C2) where the code is
   * a function on the native lane whose closures are function objects and that reads its own `this`, the strictness
   * it binds `this` with (`ambientThisStrict`, C2-D2): the receiver the dispatcher installed, read once at entry. In a
   * program that creates no function value nothing calls through the dispatcher, so `this` stays unbound there.
   */
  readonly codeStrictness: CodeStrictness;
  /**
   * {@link legalizeSourceDynamicValues} for the functions lowered from `roots`. `converts` names a call that converts
   * its arguments itself (#7354 T: an admitted `isNaN(v)`), so an argument has no implicit flow into its parameter.
   */
  readonly legalize: (
    roots: ts.FunctionDeclaration | readonly ts.Statement[],
    functions: readonly IrFunction[],
    owners: RefusalOwners,
    converts: (call: ts.CallExpression) => boolean,
  ) => readonly IrFunction[];
}

/** (#7354 U) What the legalization needs to give its refusals an owner (`abort-bodies.ts`). */
export interface RefusalOwners {
  /** The declaration a lowered function was lowered from. */
  readonly declarationOf: (unit: IrUnitId) => ts.Node | undefined;
  /** The function's body is the abort: its statements were never lowered, so no rule reads them. */
  readonly aborted: (fn: ts.FunctionLikeDeclaration) => boolean;
}

/**
 * `allocations` is the producer's registry: (#7354 Fa) the legalization re-types the closure sites in it. `input` is
 * the producer's: its checker, policy and the compiler's answer to the strictness of a piece of code.
 */
export function programDynamicContracts(
  input: {
    readonly checker: ts.TypeChecker;
    readonly policy: SourcePolicy;
    readonly codeStrictness?: (node: ts.FunctionLikeDeclaration | ts.SourceFile) => boolean;
  },
  sourceFiles: readonly ts.SourceFile[],
  allocations: AllocSiteRegistry,
): ProgramDynamicContracts {
  const { checker, policy } = input;
  // (#7354 O2, O2b) What the source allows its objects: one answer every group asks.
  // (#7354 F1b) A function object's `name` is a native string.
  const functionObjects = nativeDynamicLane(policy) && policy.stringConst?.storage === "native";
  const functionDeclarationValues = functionObjects ? functionDeclarationsReadAsValues(checker, sourceFiles) : [];
  const objects = programObjects(sourceFiles, functionDeclarationValues.length > 0);
  const codeStrictness: ProgramDynamicContracts["codeStrictness"] = (code) => {
    const functionCodeStrict = input.codeStrictness?.(code);
    return functionObjects &&
      objects.functions &&
      functionCodeStrict !== undefined &&
      !ts.isSourceFile(code) &&
      readsAmbientThisGlobal(code)
      ? { functionCodeStrict, ambientThisStrict: functionCodeStrict }
      : { functionCodeStrict };
  };
  const bindsReceiver = (node: ts.Node): boolean =>
    (ts.isFunctionExpression(node) && codeStrictness(node).ambientThisStrict !== undefined) ||
    ts.forEachChild(node, bindsReceiver) === true;
  const closuresBindReceivers = functionObjects && sourceFiles.some(bindsReceiver);
  const provenance = sourceDynamicProvenance(
    checker,
    sourceFiles,
    nativeDynamicLane(policy),
    (declaration, carries) => sourceDynamicResult(checker, policy, declaration, carries) !== undefined,
    (declaration, parameter) => sourceDynamicParameter(checker, policy, declaration, parameter)?.kind === "dynamic",
  );
  return {
    ...provenance,
    functionDeclarationValues,
    codeStrictness,
    parameter: (declaration, parameter) => sourceDynamicParameter(checker, policy, declaration, parameter),
    resolver: nativeDynamicLane(policy)
      ? {
          resolveDynamic: () => ({ kind: "externref" }),
          dynamicCarrierIsExternref: () => true,
          unresolvedNameIsAbsent: (node) => absentGlobal(checker, node),
          dynamicClosureSignature: (expression) => sourceDynamicClosureSignature(policy, expression),
          staticFunctionValue: (declaration) =>
            !closuresBindReceivers && staticFunctionValue(policy, sourceFiles, declaration),
          closuresBindReceivers: () => closuresBindReceivers,
          createsFunctionObjects: () => functionObjects,
          isPristineBuiltinGlobal: pristineBuiltinGlobal(checker, sourceFiles),
          closureCodeStrictness: codeStrictness,
        }
      : {},
    result: (declaration) =>
      sourceDynamicResult(checker, policy, declaration, provenance.carries) ??
      sourceBooleanResult(checker, policy, declaration),
    propagatedResult: (declaration, propagated) => {
      if (propagated || !irFunctionBodyReturnsValue(declaration.body!)) return propagated ?? null;
      const result = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(declaration)!);
      // `return undefined;` is the void result a call reads as `undefined`.
      if (result.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return null;
      throw new IrUnsupportedError(
        "type-resolution-unsupported",
        "build",
        `function ${declaration.name?.text} returns ${checker.typeToString(result)}, which has no Prepared result contract`,
      );
    },
    legalize: (roots, functions, owners, converts) =>
      legalizeSourceDynamicValues(
        checker,
        policy,
        roots,
        functions,
        provenance.carries,
        sourceFiles,
        allocations,
        objects,
        owners,
        converts,
      ),
  };
}

/**
 * (#7354 Ty, T) `typeof X` answers "undefined" only for a name that nothing declares: the checker resolves it to no
 * symbol, neither the program's nor the loaded TypeScript lib's (`globalThis` resolves to a symbol without
 * declarations). The lib stands in for the list of standard globals; it is not exactly that list (see #7354 "Slice T
 * result", known limits: a later-edition global it does not declare, DOM names it does). A
 * standard global this path does not provide yet (`Math`, `parseInt`, `Object`, …) is not absent: its `typeof`, like
 * every other read of it, refuses by name (an abort body inside a function under the test262 entry), never
 * "undefined" (node says `typeof Math === "object"`). A script's top-level `function Error() {}` is reported by the
 * checker as the lib declarations alone, hence the file check.
 */
function absentGlobal(checker: ts.TypeChecker, node: ts.Identifier): boolean {
  return isUndeclaredInFile(node) && checker.getSymbolAtLocation(node) === undefined;
}

/**
 * (#7354 D1) The one rule for a dynamic value leaving the dynamic domain. A
 * value that may be dynamic (`carries`: a checker `any`, or since #7354 H a
 * value read from a dynamic home) whose contextual type is not `any` (an
 * argument for a typed parameter, the value returned from a typed result, the
 * initializer or assigned value of a typed binding, a property or element of a
 * typed literal) would cross into that type with no conversion the source
 * wrote. The Prepared path has no checked unbox yet (a mismatch must convert or
 * throw, never pass), so the flow refuses by name. A store into a binding that
 * itself holds the dynamic value is no such flow, whatever the checker types
 * that binding (`landsInCarrier`). An operator that converts explicitly (`+v`,
 * `v * 2`, `v === w`) gives its operand no contextual type; the legalization
 * expresses it or refuses it by name.
 */
function refuseImplicitDynamicFlows(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  roots: readonly ts.Node[],
  carries: Carries,
  aborted: RefusalOwners["aborted"],
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
  converts: (call: ts.CallExpression) => boolean,
): void {
  const any = checker.getAnyType();
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && aborted(node)) return;
    const converted = ts.isCallExpression(node.parent) && node.parent.expression !== node && converts(node.parent);
    const exempt = (e: ts.Expression) => passedOn(e) || converted || objectStaticOperand(e, isPristineGlobal);
    if (ts.isExpression(node) && !exempt(node) && carries(node)) {
      const contextual = checker.getContextualType(node);
      if (contextual !== undefined && contextual !== any && !landsInCarrier(node, checker, policy, carries))
        throw ownRefusal(
          new IrUnsupportedError(
            "type-resolution-unsupported",
            "build",
            `a dynamic value flows into ${checker.typeToString(contextual)} without a conversion (${ts.SyntaxKind[node.parent.kind]})`,
          ),
          node,
        );
    }
    ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
}

/**
 * `node`'s value is its parent's (a parenthesis, a conditional's branch, a comma's result, since #7354 T an
 * operand of `||`/`&&`, which yields one of its operands): the parent's flow counts. A conditional's test has no
 * contextual type, so skipping it too loses no check.
 */
function passedOn(node: ts.Expression): boolean {
  const { parent } = node;
  if (ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent)) return true;
  if (!ts.isBinaryExpression(parent)) return false;
  const operator = parent.operatorToken.kind;
  return (
    (operator === ts.SyntaxKind.CommaToken && parent.right === node) ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandToken
  );
}

/**
 * `value` lands where the dynamic value is held, whatever the checker types that place: stored by a plain `=` into a
 * binding that may hold it, or (#7354 W2) the initializer of such a binding, an argument for a parameter whose
 * contract is dynamic, a value returned from a function whose result is. The checker reads the type of the last
 * three from a JSDoc tag, which is a comment (`syntacticAnnotation`); a syntactically annotated binding, parameter
 * or result never holds the dynamic value, so the flow into it stays checked.
 */
function landsInCarrier(value: ts.Expression, checker: ts.TypeChecker, policy: SourcePolicy, carries: Carries) {
  const { parent } = value;
  if (ts.isBinaryExpression(parent))
    return parent.right === value && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && carries(parent.left);
  if (ts.isVariableDeclaration(parent))
    return parent.initializer === value && ts.isIdentifier(parent.name) && carries(parent.name);
  if (ts.isReturnStatement(parent)) {
    const owner = ts.findAncestor(parent, ts.isFunctionLike);
    return (
      owner !== undefined &&
      ts.isFunctionDeclaration(owner) &&
      sourceDynamicResult(checker, policy, owner, carries)?.kind === "dynamic"
    );
  }
  if (!ts.isCallExpression(parent) || parent.expression === value) return false;
  // (#7354 F2, P1) A method call on a dynamic receiver is the [[Get]], then the dispatcher's call, which takes every
  // argument as a carrier whatever the lib types the method (`o.hasOwnProperty(k)`'s `PropertyKey`).
  const access = parent.expression;
  if ((ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && carries(access.expression))
    return true;
  const callee = sourceFunctionCallee(checker, parent);
  if (callee === undefined) return false;
  const parameter = callee.parameters[parent.arguments.indexOf(value)];
  return parameter !== undefined && sourceDynamicParameter(checker, policy, callee, parameter)?.kind === "dynamic";
}

/**
 * (#7354 D1) On the native dynamic lane every function lowered from `declaration` is legalized to the
 * intrinsic/externref form; an operation without a Prepared intrinsic is a named refusal, and a function without a
 * dynamic value is returned unchanged. (#7354 M1) This used to depend on the program having a dynamic contract (an
 * `any`, an untyped parameter, a script var's dynamic home, a catch binding, a `typeof` of an absent name): a function
 * that from-ast gave a dynamic value without one (a member read off a function-local object, a string under unary
 * `+`) kept it unlegalized, and the projection's validator met a `dynamic` type before the planner's late refusal.
 * The flow rule runs only where a dynamic value was lowered: in a function without one, no value can leave the
 * dynamic domain. (#7354 O1, O4) In a program that reads a catch binding, every function's throws are checked either
 * way: that catch, in whichever group, reads the payload as the dynamic value. Without one, no source code reads a
 * payload, so a throw the compiler synthesizes (a TDZ `ReferenceError`, a member-access TypeError) keeps its own, and
 * a catch that only binds or rethrows it still catches it: the realm and the source throw under one tag.
 */
function legalizeSourceDynamicValues(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  functions: readonly IrFunction[],
  carries: Carries,
  sourceFiles: readonly ts.SourceFile[],
  allocations: AllocSiteRegistry,
  objects: ProgramObjects,
  owners: RefusalOwners,
  converts: (call: ts.CallExpression) => boolean,
): readonly IrFunction[] {
  const roots = "kind" in declaration ? [declaration] : declaration;
  if (!nativeDynamicLane(policy)) return functions;
  // (#7354 Str2) Number::toString has one binding on this lane, typed or dynamic (number-to-string-target.ts).
  const retargeted = functions.map(retargetNumberToString);
  const catches = sourceFiles.some(readsCatchPayload);
  // A gap is the refusal of the function it was met in.
  const owned = <T>(fn: IrFunction, step: () => T): T => {
    try {
      return step();
    } catch (error) {
      if (!(error instanceof DynamicValueGap)) throw error;
      throw ownRefusal(
        new IrUnsupportedError("type-resolution-unsupported", "build", error.message),
        owners.declarationOf(fn.unitId),
      );
    }
  };
  const legalized = retargeted.map((fn) =>
    owned(fn, () => legalizeDynamicValues(fn, allocations, { objects, catches })),
  );
  if (catches) retargeted.forEach((fn) => owned(fn, () => refuseUnadmittedThrows(fn)));
  if (legalized.some((fn, index) => fn !== retargeted[index]))
    refuseImplicitDynamicFlows(
      checker,
      policy,
      roots,
      carries,
      owners.aborted,
      pristineBuiltinGlobal(checker, sourceFiles),
      converts,
    );
  legalizeDynamicAllocations(legalized, allocations);
  return legalized;
}

/**
 * `node` holds a `catch` clause whose binding reads the payload: a destructuring pattern, or the bound name anywhere
 * in the clause's block but as the operand of a rethrow (`throw e;` passes the payload on unread).
 */
function readsCatchPayload(node: ts.Node): boolean {
  if (ts.isCatchClause(node) && node.variableDeclaration && readsBinding(node.variableDeclaration.name, node.block))
    return true;
  return ts.forEachChild(node, readsCatchPayload) === true;
}

function readsBinding(name: ts.BindingName, block: ts.Block): boolean {
  if (!ts.isIdentifier(name)) return true;
  const named = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === name.text;
  const reads = (node: ts.Node): boolean =>
    !(ts.isThrowStatement(node) && named(node.expression)) && (named(node) || ts.forEachChild(node, reads) === true);
  return reads(block);
}
