// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import type { IrProgramSourceInput } from "./program-source.js";
import {
  buildNativeFamilyLogicalVectors,
  type NativeFamilyVectorNode,
  type NativeFamilyVectorType,
} from "./program-logical-types.js";
import { IrUnsupportedError } from "../shared/contracts/ir-preparation-errors.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import { assertNativeIrPolicy, isLegacyHostIrPolicy } from "./runtime/target-admission.js";

/** Read only an explicitly selected own data field; never evaluate a getter. */
export function sourceDataField<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor))
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `source capture requires own data field ${String(key)}`,
    );
  return descriptor.value;
}

/** Select explicit own-DATA native f64 lowering after canonical native policy admission. */
export function selectNativeLinearVectorProjection(input: IrProgramSourceInput): boolean {
  const selected = Object.hasOwn(input, "linearVectorProjection");
  if (selected || !isLegacyHostIrPolicy(input.policy)) assertNativeIrPolicy(input.policy);
  if (!selected) return false;
  if (
    sourceDataField(input, "linearVectorProjection") !== "native-f64" ||
    !["linear", "wasmgc"].includes(input.policy.backend)
  )
    throw new IrUnsupportedError(
      "type-resolution-unsupported",
      "select",
      "native f64 vector projection requires native Wasm policy",
    );
  return true;
}

/** The genuine inventory-owned synchronous declaration supplies the existing logical collector. */
export function nativeLinearSourceVectors(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration,
  asyncKeyword: ts.SyntaxKind.AsyncKeyword,
): ReadonlyMap<NativeFamilyVectorNode, NativeFamilyVectorType> | undefined {
  if (!declaration.body || declaration.modifiers?.some((modifier) => modifier.kind === asyncKeyword)) return undefined;
  const facts = buildNativeFamilyLogicalVectors(checker, declaration, new Map());
  for (const type of facts.values())
    if (
      Object.hasOwn(type, "layout") ||
      type.elementType.kind !== "val" ||
      Object.hasOwn(type.elementType, "typeRef") ||
      type.elementType.val.kind !== "f64"
    )
      throw new IrUnsupportedError(
        "type-resolution-unsupported",
        "build",
        "native vectors require layout-free f64 elements",
      );
  return facts;
}

export function selectNativeAsyncFamilyProjection(input: IrProgramSourceInput): boolean {
  const projection = input.asyncFamilyProjection;
  if (projection === undefined || projection === "disabled") return false;
  if (
    projection !== "standalone-native" ||
    input.promiseDelayProjection !== "standalone-native" ||
    input.policy.backend !== "wasmgc" ||
    input.policy.target !== "standalone"
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native async family source projection requires explicit native delay and wasmgc:standalone policy",
    );
  return true;
}
