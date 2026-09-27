// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
export interface SignatureFact {
  params: TypeFact[];
  returns: TypeFact;
  declaredArity: number;
}

export interface ShapeFact {
  props: { name: string; fact: TypeFact; optional?: boolean }[];
}

/**
 * Registry-free type facts. Strictly ABOVE ValType: nothing here indexes a
 * Wasm module type table.
 */
export type TypeFact =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "bigint" }
  | { kind: "symbol" }
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "void" }
  | { kind: "array"; element: TypeFact }
  | { kind: "tuple"; elements: TypeFact[] }
  | { kind: "function"; signature?: SignatureFact }
  | { kind: "class"; name: string }
  | { kind: "builtin"; name: string }
  | { kind: "object"; shape?: ShapeFact }
  | { kind: "union"; parts: TypeFact[]; nullable: boolean; undefinable: boolean }
  | { kind: "any" }
  | { kind: "unknown" }
  | { kind: "unresolvable" };

/** Zero-based parameter index or return slot, descending through callable types. */
export type SignaturePositionPath = readonly (number | "return")[];
