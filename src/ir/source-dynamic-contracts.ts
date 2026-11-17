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
 *   value the body returns: it is `any` or `unknown`, a JSDoc `@returns`
 *   names it, or the body can also run off its end (that path returns
 *   `undefined`). Other
 *   unannotated results keep the producer's inference, which the middle end
 *   checks against the lowered body. Either contract triggers the legalization
 *   below like an explicit `any`.
 */
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import type { IrFunction } from "./core/nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import { DynamicValueGap, legalizeDynamicValues } from "./program/dynamic-value-legalization.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";
import { functionBodyAlwaysTerminates, irFunctionBodyReturnsValue } from "./select.js";

type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target">;
const IR_BOOLEAN_RESULT: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });
type DynamicLane = "host-async" | "native" | undefined;

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

function annotatedAny(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): boolean {
  return annotation !== undefined && checker.getTypeFromTypeNode(annotation) === checker.getAnyType();
}

/**
 * A value an unannotated body returns that the checker cannot vouch for: the checker says `any` or `unknown` (a
 * caught exception, #7354 X), a JSDoc `@returns` (unchecked at runtime) names it, or the body can also run off
 * its end, which returns `undefined`.
 */
function uncheckedResult(declaration: ts.FunctionDeclaration, checkerUntyped: boolean): boolean {
  const body = declaration.body;
  return (
    body !== undefined &&
    irFunctionBodyReturnsValue(body) &&
    (checkerUntyped || ts.getJSDocReturnType(declaration) !== undefined || !functionBodyAlwaysTerminates(body))
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

function dynamicLane(policy: SourcePolicy, declaration: ts.FunctionDeclaration | undefined): DynamicLane {
  if (policy.backend !== "wasmgc") return undefined;
  const has = (kind: ts.SyntaxKind) => declaration?.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
  if (has(ts.SyntaxKind.AsyncKeyword)) return policy.target === "host" ? "host-async" : undefined;
  return policy.target === "standalone" && !has(ts.SyntaxKind.ExportKeyword) ? "native" : undefined;
}

/** The dynamic (or host Promise) contract of a parameter, if its lane admits one; natively also an unannotated one. */
export function sourceDynamicParameter(
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
 * unannotated result the checker cannot vouch for. (#7354 T/X review) Natively an unannotated result the
 * checker types Boolean is the Boolean carrier: the propagated result (shared with the ordinary pipeline)
 * lowers it to a plain `i32`, which the presentation's source-declaration join refuses (`return e === 3`,
 * `return 1 === 1` in a parameterless function).
 */
export function sourceDynamicResult(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration,
): IrType | undefined {
  const lane = dynamicLane(policy, declaration);
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!lane || !signature) return undefined;
  const any = checker.getAnyType();
  const result = checker.getReturnTypeOfSignature(signature);
  if (lane === "native") {
    const dynamic = declaration.type
      ? annotatedAny(checker, declaration.type) && result === any
      : uncheckedResult(declaration, result === any || result === checker.getUnknownType());
    if (dynamic) return { kind: "dynamic" };
    return !declaration.type && (result.flags & ts.TypeFlags.BooleanLike) !== 0 ? IR_BOOLEAN_RESULT : undefined;
  }
  if (hostPromiseFulfillment(checker, result) !== any) return undefined;
  if (declaration.type && hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== any)
    return undefined;
  return { kind: "dynamic" };
}

/**
 * from-ast lowers a dynamic value only where the lane has its carrier. (#7354 T) That carrier is the raw
 * `externref`: `null` is its null reference (from-ast's dynamic `null` literal and `=== null` test), and a
 * catch binding reads the exception payload as the dynamic value. Invariant: every payload that can reach a
 * catch is in the admitted set (a dynamic value, a boxed number, `null`) or an Error object, for which every
 * dynamic operation is exact too. A string, Boolean or object throw, a TDZ ReferenceError and the runtime's
 * null-vector throw (`ref.null extern`, which would read as `null`) all refuse before a catch today; the
 * slice that makes one reachable updates tests/issue-7354-x-dynamic-throw.test.ts, which pins each.
 */
export function sourceDynamicResolver(policy: SourcePolicy): {
  readonly resolveDynamic?: () => ValType;
  readonly dynamicCarrierIsExternref?: () => boolean;
} {
  return dynamicLane(policy, undefined) === "native"
    ? { resolveDynamic: () => ({ kind: "externref" }), dynamicCarrierIsExternref: () => true }
    : {};
}

/**
 * (#7354 D1) The one rule for a dynamic value leaving the dynamic domain. An
 * `any` expression (or, since T, an `unknown` one: a catch binding is the
 * dynamic value) whose contextual type is neither (an argument for a typed
 * parameter, the value returned from a typed result, the initializer or
 * assigned value of a typed binding, a property or element of a typed literal)
 * would cross into that type with no conversion the source wrote. The Prepared
 * path has no checked unbox yet (a mismatch must convert or throw, never pass),
 * so the flow refuses by name; a type assertion (`e as number`) converts
 * nothing and is such a flow. An operator that converts explicitly (`+v`,
 * `v * 2`, `v === w`) gives its operand no contextual type; the legalization
 * expresses it or refuses it by name.
 */
function refuseImplicitDynamicFlows(checker: ts.TypeChecker, roots: readonly ts.Node[]): void {
  const untyped = (type: ts.Type | undefined) => type === checker.getAnyType() || type === checker.getUnknownType();
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && untyped(checker.getTypeAtLocation(node))) {
      const contextual = checker.getContextualType(node);
      if (contextual !== undefined && !untyped(contextual))
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
 * (#7354 D1) On the native lane every function lowered from `declaration` is
 * legalized to the intrinsic/externref form; an operation without a Prepared
 * intrinsic is a named refusal. A function without a dynamic value is returned
 * unchanged, so a program without one keeps its exact IR. The flow rule runs
 * only where a dynamic value was lowered: a checker `any` the IR typed
 * concretely (an untyped parameter with a propagated number type) carries no
 * dynamic value.
 */
export function legalizeSourceDynamicValues(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  functions: readonly IrFunction[],
): readonly IrFunction[] {
  if (dynamicLane(policy, undefined) !== "native") return functions;
  let legalized: readonly IrFunction[];
  try {
    legalized = functions.map(legalizeDynamicValues);
  } catch (error) {
    if (!(error instanceof DynamicValueGap)) throw error;
    throw new IrUnsupportedError("type-resolution-unsupported", "build", error.message);
  }
  if (legalized.some((fn, index) => fn !== functions[index]))
    refuseImplicitDynamicFlows(checker, "kind" in declaration ? [declaration] : declaration);
  return legalized;
}
