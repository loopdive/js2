// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";

/** Captured recipe operands, not native provider admission/completion evidence. */
export interface AnyToStringBindings {
  readonly anyStrTypeIdx: number;
  readonly anyValueTypeIdx: number;
  readonly numToStrIdx: number | undefined;
  readonly errToStrIdx: number | undefined;
  readonly errStructTypeIdx: number;
  readonly dateToStrIdx: number | undefined;
  readonly dateStructTypeIdx: number;
  readonly classToPrimIdx: number | undefined;
  readonly boxNumTerminalIdx: number;
  readonly boxBoolTerminalIdx: number;
  readonly argumentsVecTypeIdx: number;
  readonly toPrimitiveIdx: number | undefined;
  readonly objectRuntimePresent: boolean;
  readonly boxNumIdxEarly: number;
  readonly boxBoolIdxEarly: number;
}
export type AnyToStringLiteral = "null" | "undefined" | "true" | "false" | "[object Object]" | "[object Arguments]";
export type AnyToStringRequest =
  | { readonly kind: "literal"; readonly value: AnyToStringLiteral }
  | { readonly kind: "arguments-brand" }
  | { readonly kind: "object-type" }
  | { readonly kind: "residual-box-types" };
export type AnyToStringResponse =
  | { readonly kind: "literal"; readonly value: AnyToStringLiteral; readonly instructions: Instr[] }
  | { readonly kind: "arguments-brand"; readonly index: number | undefined }
  | { readonly kind: "object-type"; readonly index: number }
  | { readonly kind: "residual-box-types"; readonly boxNumIdx: number; readonly boxBoolIdx: number };
export type AnyToStringSteps<T> = Generator<AnyToStringRequest, T, AnyToStringResponse>;

export function* literalString(value: AnyToStringLiteral): AnyToStringSteps<Instr[]> {
  const response = yield { kind: "literal", value };
  if (response.kind !== "literal" || response.value !== value) throw new Error("AnyToString: wrong literal response");
  return structuredClone(response.instructions);
}
export function* readArgumentsBrand(): AnyToStringSteps<number | undefined> {
  const response = yield { kind: "arguments-brand" };
  if (response.kind !== "arguments-brand") throw new Error("AnyToString: wrong arguments-brand response");
  return response.index;
}
export function* readObjectType(): AnyToStringSteps<number> {
  const response = yield { kind: "object-type" };
  if (response.kind !== "object-type") throw new Error("AnyToString: wrong object-type response");
  return response.index;
}
export function* readResidualBoxTypes(): AnyToStringSteps<{ boxNumIdx: number; boxBoolIdx: number }> {
  const response = yield { kind: "residual-box-types" };
  if (response.kind !== "residual-box-types") throw new Error("AnyToString: wrong residual-box-types response");
  return { boxNumIdx: response.boxNumIdx, boxBoolIdx: response.boxBoolIdx };
}
