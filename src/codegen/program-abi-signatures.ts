// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ProgramAbiCallableSignature } from "../ir/program-abi.js";
import type { ValType } from "../ir/types.js";

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

export function canonicalProgramAbiValType(type: ValType): string {
  switch (type.kind) {
    case "i32":
      return JSON.stringify({
        kind: type.kind,
        ...(type.boolean === true ? { boolean: true as const } : {}),
        ...(type.symbol === true ? { symbol: true as const } : {}),
      });
    case "i64":
      return JSON.stringify({
        kind: type.kind,
        ...(type.bigint === true ? { bigint: true as const } : {}),
      });
    case "ref":
    case "ref_null":
      return JSON.stringify({ kind: type.kind, typeIdx: type.typeIdx });
    default:
      return JSON.stringify({ kind: type.kind });
  }
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
