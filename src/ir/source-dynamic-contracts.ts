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
 *   value the body returns: it is `any`, a JSDoc `@returns` names it, or the
 *   body can also run off its end (that path returns `undefined`). Other
 *   unannotated results keep the producer's inference, which the middle end
 *   checks against the lowered body. Either contract triggers the legalization
 *   below like an explicit `any`.
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
import { DynamicValueGap, legalizeDynamicValues } from "./program/dynamic-value-legalization.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";
import { functionBodyAlwaysTerminates, irFunctionBodyReturnsValue } from "./select.js";
import { outermostParenthesized } from "../shared/binding-writes.js";
import { sourceDynamicProvenance, type SourceDynamicProvenance } from "./source-dynamic-provenance.js";

type Carries = SourceDynamicProvenance["carries"];
type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target">;
type DynamicLane = "host-async" | "native" | undefined;

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

function annotatedAny(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): boolean {
  return annotation !== undefined && checker.getTypeFromTypeNode(annotation) === checker.getAnyType();
}

/**
 * A value an unannotated body returns that the checker cannot vouch for: the checker says `any`, a JSDoc
 * `@returns` (unchecked at runtime) names it, the body can also run off its end, which returns `undefined`, or
 * (#7354 H) a returned value may be the dynamic value whatever the checker infers for it.
 */
function uncheckedResult(declaration: ts.FunctionDeclaration, checkerSaysAny: boolean, carries: Carries): boolean {
  const body = declaration.body;
  return (
    body !== undefined &&
    irFunctionBodyReturnsValue(body) &&
    (checkerSaysAny ||
      ts.getJSDocReturnType(declaration) !== undefined ||
      !functionBodyAlwaysTerminates(body) ||
      returnsCarry(body, carries))
  );
}

/** Some `return` of `body` (not of a nested function) may return the dynamic value. */
function returnsCarry(body: ts.Block, carries: Carries): boolean {
  const visit = (node: ts.Node): boolean =>
    ts.isReturnStatement(node)
      ? node.expression !== undefined && carries(node.expression)
      : !ts.isFunctionLike(node) && !ts.isClassLike(node) && ts.forEachChild(node, visit) === true;
  return ts.forEachChild(body, visit) === true;
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
    const dynamic = declaration.type
      ? annotatedAny(checker, declaration.type) && result === any
      : uncheckedResult(declaration, result === any, carries);
    return dynamic ? { kind: "dynamic" } : undefined;
  }
  if (hostPromiseFulfillment(checker, result) !== any) return undefined;
  if (declaration.type && hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== any)
    return undefined;
  return { kind: "dynamic" };
}

function nativeDynamicLane(policy: SourcePolicy): boolean {
  return dynamicLane(policy, undefined) === "native";
}

/** (#7354 H) The dynamic-value contracts of one program's sources, over its provenance. */
export interface ProgramDynamicContracts extends SourceDynamicProvenance {
  /** The dynamic (or host Promise) contract of a parameter of `declaration`, if any. */
  readonly parameter: (declaration: ts.FunctionDeclaration, parameter: ts.ParameterDeclaration) => IrType | undefined;
  /** The dynamic result contract of `declaration`, if any. */
  readonly result: (declaration: ts.FunctionDeclaration) => IrType | undefined;
  /** from-ast lowers a dynamic value only where the lane has its carrier. */
  readonly resolver: { readonly resolveDynamic?: () => ValType };
  /** {@link legalizeSourceDynamicValues} for the functions lowered from `roots`. */
  readonly legalize: (
    roots: ts.FunctionDeclaration | readonly ts.Statement[],
    functions: readonly IrFunction[],
  ) => readonly IrFunction[];
}

export function programDynamicContracts(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  sourceFiles: readonly ts.SourceFile[],
): ProgramDynamicContracts {
  const provenance = sourceDynamicProvenance(
    checker,
    sourceFiles,
    nativeDynamicLane(policy),
    (declaration, carries) => sourceDynamicResult(checker, policy, declaration, carries) !== undefined,
  );
  return {
    ...provenance,
    parameter: (declaration, parameter) => sourceDynamicParameter(checker, policy, declaration, parameter),
    resolver: nativeDynamicLane(policy) ? { resolveDynamic: () => ({ kind: "externref" }) } : {},
    result: (declaration) => sourceDynamicResult(checker, policy, declaration, provenance.carries),
    legalize: (roots, functions) => legalizeSourceDynamicValues(checker, policy, roots, functions, provenance.carries),
  };
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
 * that binding. An operator that converts explicitly (`+v`, `v * 2`, `v === w`)
 * gives its operand no contextual type; the legalization expresses it or
 * refuses it by name.
 */
function refuseImplicitDynamicFlows(checker: ts.TypeChecker, roots: readonly ts.Node[], carries: Carries): void {
  const any = checker.getAnyType();
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && carries(node)) {
      const contextual = checker.getContextualType(node);
      if (contextual !== undefined && contextual !== any && !storedIntoCarrier(outermostParenthesized(node), carries))
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

/** `value` is a variable's initializer or the value of a plain `=` into a binding that may hold the dynamic value. */
function storedIntoCarrier(value: ts.Expression, carries: Carries): boolean {
  const { parent } = value;
  if (ts.isVariableDeclaration(parent))
    return parent.initializer === value && ts.isIdentifier(parent.name) && carries(parent.name);
  return (
    ts.isBinaryExpression(parent) &&
    parent.right === value &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    carries(parent.left)
  );
}

/**
 * (#7354 D1) On the native lane every function lowered from `declaration` is
 * legalized to the intrinsic/externref form; an operation without a Prepared
 * intrinsic is a named refusal. A function without a dynamic value is returned
 * unchanged, so a program without one keeps its exact IR. The flow rule runs
 * only where a dynamic value was lowered: a checker `any` the IR typed
 * concretely (an untyped parameter with a propagated number type) carries no
 * dynamic value.
 */
function legalizeSourceDynamicValues(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  functions: readonly IrFunction[],
  carries: Carries,
): readonly IrFunction[] {
  if (!nativeDynamicLane(policy)) return functions;
  let legalized: readonly IrFunction[];
  try {
    legalized = functions.map(legalizeDynamicValues);
  } catch (error) {
    if (!(error instanceof DynamicValueGap)) throw error;
    throw new IrUnsupportedError("type-resolution-unsupported", "build", error.message);
  }
  if (legalized.some((fn, index) => fn !== functions[index]))
    refuseImplicitDynamicFlows(checker, "kind" in declaration ? [declaration] : declaration, carries);
  return legalized;
}
