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
import {
  DynamicValueGap,
  legalizeDynamicAllocations,
  legalizeDynamicValues,
  refuseUnadmittedThrows,
} from "./program/dynamic-value-legalization.js";
import type { ProgramKinds } from "./program/dynamic-value-kinds.js";
import { retargetNumberToString } from "./program/number-to-string-target.js";
import { programObjects } from "./source-plain-objects.js";
import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";
import { functionBodyAlwaysTerminates, irFunctionBodyReturnsValue } from "./select.js";
import { someReturnedValue } from "./function-returns.js";
import { sourceDynamicProvenance, type SourceDynamicProvenance } from "./source-dynamic-provenance.js";
import { scriptVarWrites } from "./module-binding-script-var.js";
import { isTopLevelStatementDeclaration } from "../shared/var-declaration-lists.js";
import { sourceMayWriteGlobalObject, sourceRunsDynamicCode } from "../shared/intrinsic-prototype-writes.js";
import { isUndeclaredInFile } from "../shared/ambient-intrinsics.js";

type Carries = SourceDynamicProvenance["carries"];
type Signature = { readonly params: readonly IrType[]; readonly returnType: IrType | null };
/** A program global as the source producer holds it: only its storage type matters here. */
type SourceGlobal = { readonly binding: { readonly type: IrType } };
type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target">;
type DynamicLane = "host-async" | "native" | undefined;
const DYNAMIC: IrType = Object.freeze({ kind: "dynamic" });
const IR_BOOLEAN_RESULT: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
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

/** The dynamic (or host Promise) contract of a parameter, if its lane admits one; natively also an unannotated one. */
function sourceDynamicParameter(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
): IrType | undefined {
  const lane = dynamicLane(policy, declaration);
  const annotation = parameter.type;
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
    const dynamic = declaration.type
      ? annotatedAny(checker, declaration.type) && result === any
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
 * a pattern, and a generator or async literal, have no such contract.
 */
function sourceDynamicClosureSignature(
  policy: SourcePolicy,
  expression: ts.FunctionExpression,
): { readonly params: readonly IrType[]; readonly returnType: IrType } | undefined {
  if (
    !nativeDynamicLane(policy) ||
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
 * statement's declarator of the program's only source, written nowhere else, in a source that neither runs code it
 * does not spell nor lets the global object escape (which could write the binding by a computed name). from-ast
 * keeps the closure on the binding's module-init scope entry when it lowers the store, so only module-init code
 * after the declaration, outside every function, sees it: there the slot holds exactly that closure, and a call
 * through the name is the closure's direct call.
 */
function staticFunctionValue(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.VariableDeclaration,
): boolean {
  const { initializer } = declaration;
  if (
    sourceFiles.length !== 1 ||
    !initializer ||
    !ts.isFunctionExpression(initializer) ||
    !sourceDynamicClosureSignature(policy, initializer) ||
    !isTopLevelStatementDeclaration(declaration)
  )
    return false;
  const source = declaration.getSourceFile();
  if (sourceRunsDynamicCode(source) || sourceMayWriteGlobalObject(source)) return false;
  const writes = scriptVarWrites(checker, declaration);
  return writes?.length === 1 && writes[0]!.target === declaration.name;
}

/** The lane has the native dynamic carrier (wasmgc standalone). */
export function nativeDynamicLane(policy: SourcePolicy): boolean {
  return dynamicLane(policy, undefined) === "native";
}

/** (#7354 H) The dynamic-value contracts of one program's sources, over its provenance. */
export interface ProgramDynamicContracts extends SourceDynamicProvenance {
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
    /** (#7354 Fa) The all-dynamic signature of an unannotated function expression, if the lane admits one. */
    readonly dynamicClosureSignature?: (expression: ts.FunctionExpression) => Signature | undefined;
    /** (#7354 Fa) {@link staticFunctionValue}. */
    readonly staticFunctionValue?: (declaration: ts.VariableDeclaration) => boolean;
    readonly unresolvedNameIsAbsent?: (node: ts.Identifier) => boolean;
  };
  /** {@link legalizeSourceDynamicValues} for the functions lowered from `roots`. */
  readonly legalize: (
    signatures: Iterable<Signature>,
    globals: readonly SourceGlobal[],
    roots: ts.FunctionDeclaration | readonly ts.Statement[],
    functions: readonly IrFunction[],
  ) => readonly IrFunction[];
}

/** `allocations` is the producer's registry: (#7354 Fa) the legalization re-types the closure sites in it. */
export function programDynamicContracts(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  sourceFiles: readonly ts.SourceFile[],
  allocations: AllocSiteRegistry,
): ProgramDynamicContracts {
  // (#7354 O2, Fa) The kinds the program's values may be beyond the primitives, one answer every group asks: whether
  // it builds objects and whether they are plain; and whether it creates function values, which enter the carrier
  // only as all-dynamic closures.
  const kinds: ProgramKinds = {
    objects: programObjects(checker, sourceFiles),
    functions: sourceFiles.some((file) => holdsDynamicClosure(policy, file)),
  };
  const provenance = sourceDynamicProvenance(
    checker,
    sourceFiles,
    nativeDynamicLane(policy),
    (declaration, carries) => sourceDynamicResult(checker, policy, declaration, carries) !== undefined,
  );
  return {
    ...provenance,
    parameter: (declaration, parameter) => sourceDynamicParameter(checker, policy, declaration, parameter),
    resolver: nativeDynamicLane(policy)
      ? {
          resolveDynamic: () => ({ kind: "externref" }),
          dynamicCarrierIsExternref: () => true,
          dynamicClosureSignature: (expression) => sourceDynamicClosureSignature(policy, expression),
          staticFunctionValue: (declaration) => staticFunctionValue(checker, policy, sourceFiles, declaration),
          unresolvedNameIsAbsent: (node) => absentGlobal(checker, sourceFiles, node),
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
    legalize: (signatures, globals, roots, functions) =>
      legalizeSourceDynamicValues(
        checker,
        policy,
        signatures,
        globals,
        roots,
        functions,
        provenance.carries,
        sourceFiles,
        allocations,
        kinds,
      ),
  };
}

/**
 * (#7354 Ty) The Prepared program is closed: its global environment holds the program's own declarations and the
 * providers from-ast's read names, nothing else (no host object). So `typeof X` of a global the program does not
 * declare (only lib declarations, or none at all) answers "undefined". That is a statement about THIS environment,
 * which provides no such global yet, not ECMAScript's answer (node says `typeof Math === "object"`). It is sound
 * because (1) every value, member, call or `new` use of such a name refuses by name, so no program can use what
 * `typeof` denied — tests/issue-7354-ty-typeof-comparisons.test.ts pins that for every name of
 * `AMBIENT_TYPEOF_TAGS`, and the slice that provides one adds it to `PREPARED_PROVIDED_GLOBALS`; and (2) the error
 * is in the safe direction: a test asserting the global exists fails. The shape that could pass falsely is a test
 * whose assertions all sit under `if (typeof X !== "undefined")` (none in ES5; two in later editions, measured).
 * A script's top-level `function Error() {}` is reported by the checker as the lib declarations alone, hence the
 * file check.
 */
function absentGlobal(checker: ts.TypeChecker, sourceFiles: readonly ts.SourceFile[], node: ts.Identifier): boolean {
  if (PREPARED_PROVIDED_GLOBALS.has(node.text) || !isUndeclaredInFile(node)) return false;
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return !declarations.some((declaration) => sourceFiles.includes(declaration.getSourceFile()));
}

/**
 * The lib globals some use of which compiles on this path, so `typeof` must not deny them: it refuses by name until
 * their real answer is wired. `Number` and (#7354 Str2) `String`: direct `Number(v)` / `String(v)` calls
 * (`prepareConversionResolvers`).
 */
export const PREPARED_PROVIDED_GLOBALS: ReadonlySet<string> = new Set(["Number", "String"]);

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
 * that binding. An operator that converts explicitly (`+v`, `v * 2`, `v === w`)
 * gives its operand no contextual type; the legalization expresses it or
 * refuses it by name.
 */
function refuseImplicitDynamicFlows(checker: ts.TypeChecker, roots: readonly ts.Node[], carries: Carries): void {
  const any = checker.getAnyType();
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && !passedOn(node) && carries(node)) {
      const contextual = checker.getContextualType(node);
      if (contextual !== undefined && contextual !== any && !storedIntoCarrier(node, carries))
        throw new IrUnsupportedError(
          "type-resolution-unsupported",
          "build",
          `a dynamic value flows into ${checker.typeToString(contextual)} without a conversion (${ts.SyntaxKind[node.parent.kind]})`,
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
 * `value` is stored by a plain `=` into a binding that may hold the dynamic value. (An initializer has a contextual
 * type only under an annotation, and an annotated binding is typed by it: from-ast refuses the dynamic store.)
 */
function storedIntoCarrier(value: ts.Expression, carries: Carries): boolean {
  const { parent } = value;
  return (
    ts.isBinaryExpression(parent) &&
    parent.right === value &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    carries(parent.left)
  );
}

/**
 * (#7354 D1) A program with a native `any` contract (since #7354 P also an
 * untyped parameter's, since #7354 H also a script `var`'s dynamic home, since
 * #7354 T a catch binding, which reads the exception payload as the dynamic value, since #7354 Ty a `typeof` of
 * a name the program does not declare, whose operand is the `undefined` value) has
 * every function lowered from `declaration` legalized to the
 * intrinsic/externref form; an operation without a Prepared
 * intrinsic is a named refusal. A program without one keeps its existing path:
 * from-ast also boxes values into dynamic ones internally there (a string under
 * unary `+`), which later stages already handle
 * (`issue-3518-native-string-number-source-admission`). A function without a
 * dynamic value is returned unchanged. The flow rule runs only where a dynamic
 * value was lowered: in a function without one, no value can leave the dynamic
 * domain. (#7354 O1, O4) In a program that binds a catch, every function's throws
 * are checked either way: a catch in any group reads the payload as the dynamic
 * value; an uncaught throw never reaches one.
 */
function legalizeSourceDynamicValues(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  signatures: Iterable<Signature>,
  globals: readonly SourceGlobal[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  functions: readonly IrFunction[],
  carries: Carries,
  sourceFiles: readonly ts.SourceFile[],
  allocations: AllocSiteRegistry,
  kinds: ProgramKinds,
): readonly IrFunction[] {
  const roots = "kind" in declaration ? [declaration] : declaration;
  const contracted =
    roots.some(bindsCatch) ||
    roots.some((root) => holdsDynamicClosure(policy, root)) ||
    roots.some((root) => readsTypeofOfAbsentGlobal(checker, sourceFiles, root)) ||
    globals.some((global) => global.binding.type.kind === "dynamic") ||
    [...signatures].some(
      (signature) =>
        signature.returnType?.kind === "dynamic" || signature.params.some((type) => type.kind === "dynamic"),
    );
  if (!nativeDynamicLane(policy)) return functions;
  // (#7354 Str2) Number::toString has one binding on this lane, typed or dynamic (number-to-string-target.ts).
  const retargeted = functions.map(retargetNumberToString);
  let legalized: readonly IrFunction[] = retargeted;
  try {
    const catches = sourceFiles.some(bindsCatch);
    if (contracted) legalized = retargeted.map((fn) => legalizeDynamicValues(fn, allocations, { ...kinds, catches }));
    if (catches) retargeted.forEach(refuseUnadmittedThrows);
  } catch (error) {
    if (!(error instanceof DynamicValueGap)) throw error;
    throw new IrUnsupportedError("type-resolution-unsupported", "build", error.message);
  }
  if (legalized.some((fn, index) => fn !== retargeted[index])) refuseImplicitDynamicFlows(checker, roots, carries);
  legalizeDynamicAllocations(legalized, allocations);
  return legalized;
}

/** (#7354 Fa) `node` holds a function expression with the all-dynamic contract (nested functions included). */
function holdsDynamicClosure(policy: SourcePolicy, node: ts.Node): boolean {
  return (
    (ts.isFunctionExpression(node) && sourceDynamicClosureSignature(policy, node) !== undefined) ||
    ts.forEachChild(node, (child) => holdsDynamicClosure(policy, child)) === true
  );
}

/** `node` holds `typeof <name>` of an absent global (nested functions included). */
function readsTypeofOfAbsentGlobal(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  node: ts.Node,
): boolean {
  if (ts.isTypeOfExpression(node)) {
    let operand: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
    if (ts.isIdentifier(operand) && absentGlobal(checker, sourceFiles, operand)) return true;
  }
  return ts.forEachChild(node, (child) => readsTypeofOfAbsentGlobal(checker, sourceFiles, child)) === true;
}

/** `node` holds a `catch` clause with a binding (nested functions included: they are lowered from the same roots). */
function bindsCatch(node: ts.Node): boolean {
  return (
    (ts.isCatchClause(node) && node.variableDeclaration !== undefined) || ts.forEachChild(node, bindsCatch) === true
  );
}
