// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Where the Prepared source producer admits TypeScript's `any` as the logical
 * dynamic value, and with which carrier.
 *
 * - Host async frames keep a JS value across `await` (identity transport,
 *   physically the host's `externref`).
 * - (#7354 D1) Synchronous functions on standalone WasmGC take and return an
 *   explicitly annotated `any`: the dynamic-value legalization lowers it to the
 *   native `externref` carrier. An inferred or JSDoc `any` is not a contract
 *   here; untyped parameters stay refused until their contracts are sound.
 */
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { ValType } from "../wasm/model/instructions.js";

type SourcePolicy = Pick<RuntimeManifestPolicy, "backend" | "target">;
type DynamicLane = "host-async" | "native" | undefined;

/** Canonical any identity excludes TypeScript's separate error-any recovery type. */
export function checkerAny(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  return checker.getTypeAtLocation(node) === checker.getAnyType() ? { kind: "dynamic" } : undefined;
}

function annotatedAny(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): boolean {
  return annotation !== undefined && checker.getTypeFromTypeNode(annotation) === checker.getAnyType();
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

/** The dynamic (or host Promise) contract of an annotated parameter, if its lane admits one. */
export function sourceDynamicParameter(
  checker: ts.TypeChecker,
  policy: SourcePolicy,
  isAsync: boolean,
  parameter: ts.ParameterDeclaration,
  annotation: ts.TypeNode,
): IrType | undefined {
  const lane = dynamicLane(policy, isAsync);
  if (annotatedAny(checker, annotation)) return lane ? checkerAny(checker, parameter.name) : undefined;
  if (lane !== "host-async") return undefined;
  // Preserve logical any independently of a typed Promise's host callable carrier.
  for (const type of [checker.getTypeFromTypeNode(annotation), checker.getTypeAtLocation(parameter.name)]) {
    const fulfillment = hostPromiseFulfillment(checker, type);
    if (!fulfillment || (fulfillment.flags & ts.TypeFlags.NumberLike) === 0) return undefined;
  }
  return { kind: "val", val: { kind: "externref" } };
}

/** The dynamic result contract: `Promise<any>` on a host async frame, an annotated `any` natively. */
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
  if (lane === "native")
    return annotatedAny(checker, declaration.type) && result === any ? { kind: "dynamic" } : undefined;
  if (hostPromiseFulfillment(checker, result) !== any) return undefined;
  if (declaration.type && hostPromiseFulfillment(checker, checker.getTypeFromTypeNode(declaration.type)) !== any)
    return undefined;
  return { kind: "dynamic" };
}

/** from-ast lowers a dynamic value only where the lane has its carrier. */
export function sourceDynamicResolver(policy: SourcePolicy): { readonly resolveDynamic?: () => ValType } {
  return dynamicLane(policy, false) === "native" ? { resolveDynamic: () => ({ kind: "externref" }) } : {};
}
