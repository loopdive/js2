// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ProgramAbiCallableSignature } from "../ir/program-abi.js";
import type { FieldDef, TypeDef, ValType } from "../ir/types.js";
import { canonicalProgramAbiValType } from "../wasm/model/abi-value-key.js";
export { canonicalProgramAbiValType } from "../wasm/model/abi-value-key.js";

export interface ProgramAbiCallableTypeContract {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}

export function cloneProgramAbiValType(type: ValType): ValType {
  return Object.freeze({ ...type }) as ValType;
}

export function cloneProgramAbiCallableTypeContract(signature: {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}): ProgramAbiCallableTypeContract {
  return Object.freeze({
    params: Object.freeze(signature.params.map(cloneProgramAbiValType)),
    results: Object.freeze(signature.results.map(cloneProgramAbiValType)),
  });
}

function canonicalProgramAbiField(field: FieldDef): object {
  return {
    name: field.name,
    type: canonicalProgramAbiValType(field.type),
    mutable: field.mutable,
    ...(field.jsBoolean === true ? { jsBoolean: true as const } : {}),
    ...(field.presenceTracked === true ? { presenceTracked: true as const } : {}),
    // (#3780) The presence BIT is part of the physical layout — two modules
    // that agree on which fields are tracked but disagree on bit assignment do
    // not share an ABI.
    ...(field.presenceBit === undefined ? {} : { presenceBit: field.presenceBit }),
  };
}

function canonicalProgramAbiTypeDefValue(type: TypeDef): object {
  switch (type.kind) {
    case "func":
      return {
        kind: type.kind,
        params: type.params.map(canonicalProgramAbiValType),
        results: type.results.map(canonicalProgramAbiValType),
      };
    case "struct":
      return {
        kind: type.kind,
        fields: type.fields.map(canonicalProgramAbiField),
        superTypeIdx: type.superTypeIdx ?? null,
        final: type.final === true,
      };
    case "array":
      return {
        kind: type.kind,
        element: canonicalProgramAbiValType(type.element),
        mutable: type.mutable,
      };
    case "rec":
      return {
        kind: type.kind,
        types: type.types.map(canonicalProgramAbiTypeDefValue),
      };
    case "sub":
      return {
        kind: type.kind,
        superType: type.superType,
        final: type.final,
        type: canonicalProgramAbiTypeDefValue(type.type),
      };
  }
}

/**
 * Canonical semantic Wasm type/layout contract.
 *
 * Debug names are deliberately excluded. Field names remain because class and
 * structural-object property offsets are part of the compiler's layout ABI.
 */
export function canonicalProgramAbiTypeDef(type: TypeDef): string {
  return JSON.stringify(canonicalProgramAbiTypeDefValue(type));
}

export function canonicalProgramAbiCallableTypeContract(
  contract: ProgramAbiCallableTypeContract,
): ProgramAbiCallableSignature {
  return Object.freeze({
    params: Object.freeze(contract.params.map(canonicalProgramAbiValType)),
    results: Object.freeze(contract.results.map(canonicalProgramAbiValType)),
  });
}

export function programAbiCallableSignaturesEqual(
  left: ProgramAbiCallableSignature,
  right: ProgramAbiCallableSignature,
): boolean {
  return (
    left.params.length === right.params.length &&
    left.params.every((value, index) => value === right.params[index]) &&
    left.results.length === right.results.length &&
    left.results.every((value, index) => value === right.results[index])
  );
}
