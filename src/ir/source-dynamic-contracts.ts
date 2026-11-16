// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Where the Prepared source producer admits TypeScript's `any` as the logical
 * dynamic value, and with which carrier.
 *
 * - Host async frames keep a JS value across `await` (identity transport,
 *   physically the host's `externref`).
 * - (#7354 D1) Synchronous functions on standalone WasmGC take and return an
 *   explicitly annotated `any`: the dynamic-value legalization lowers it to the
 *   native `externref` carrier.
 * - (#7354 P) On that lane a parameter without a TypeScript annotation is the
 *   dynamic value too. Nothing checks an untyped or JSDoc-typed parameter at
 *   runtime, and its callers include top-level code, calls with missing
 *   arguments and calls through values, so no call-site type is a contract.
 *   An un-annotated result is dynamic where the checker's view of it is not a
 *   contract either: it is `any`, it comes from a JSDoc `@returns`, or the body
 *   can run off its end after returning a value (that path returns
 *   `undefined`). Other un-annotated results keep the producer's inference,
 *   which the middle end checks against the lowered body.
 */
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";
import { functionBodyAlwaysTerminates, irFunctionBodyReturnsValue } from "./select.js";

type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target">;
type DynamicLane = "host-async" | "native" | undefined;

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

function annotatedAny(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): boolean {
  return annotation !== undefined && checker.getTypeFromTypeNode(annotation) === checker.getAnyType();
}

/** A body that returns a value on one path and runs off its end on another also returns `undefined`. */
function fallsOutAfterValue(body: ts.Block | undefined): boolean {
  return body !== undefined && irFunctionBodyReturnsValue(body) && !functionBodyAlwaysTerminates(body);
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

function dynamicLane(policy: SourcePolicy, isAsync: boolean): DynamicLane {
  if (policy.backend !== "wasmgc") return undefined;
  if (isAsync) return policy.target === "host" ? "host-async" : undefined;
  return policy.target === "standalone" ? "native" : undefined;
}

/** The dynamic (or host Promise) contract of a parameter, if its lane admits one; natively also an unannotated one. */
export function sourceDynamicParameter(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  isAsync: boolean,
  parameter: ts.ParameterDeclaration,
): IrType | undefined {
  const lane = dynamicLane(policy, isAsync);
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
export function sourceDynamicResult(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  isAsync: boolean,
  declaration: ts.FunctionDeclaration,
): IrType | undefined {
  const lane = dynamicLane(policy, isAsync);
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!lane || !signature) return undefined;
  const any = checker.getAnyType();
  const result = checker.getReturnTypeOfSignature(signature);
  if (lane === "native") {
    const dynamic = declaration.type
      ? annotatedAny(checker, declaration.type) && result === any
      : result === any || ts.getJSDocReturnType(declaration) !== undefined || fallsOutAfterValue(declaration.body);
    return dynamic ? { kind: "dynamic" } : undefined;
  }
  if (hostPromiseFulfillment(checker, result) !== any) return undefined;
  if (declaration.type && hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== any)
    return undefined;
  return { kind: "dynamic" };
}

/** from-ast lowers a dynamic value only where the lane has its carrier. */
export function sourceDynamicResolver(policy: SourcePolicy): { readonly resolveDynamic?: () => ValType } {
  return dynamicLane(policy, false) === "native" ? { resolveDynamic: () => ({ kind: "externref" }) } : {};
}
