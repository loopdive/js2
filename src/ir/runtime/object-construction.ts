// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Source producer owns this allocation metadata; analyses must preserve it on clones. */
export { IR_ALLOCATION_SOURCE_FACTS as SOURCE_OBJECT_CONSTRUCTION } from "../analysis/contracts/allocations.js";
export interface IrSourceObjectConstruction {
  readonly schema: "source-object-construction-v1";
  /** Special prototype setters/method home objects need their own construction owner. */
  readonly kind: "data" | "prototype-setter" | "method";
  readonly keys: readonly string[];
}

/** Structural replay validation only: source facts never authorize a physical provider. */
export function isSourceObjectConstruction(value: unknown, fields: readonly { readonly name: string }[]): boolean {
  if (!value || typeof value !== "object") return false;
  const facts = value as Partial<IrSourceObjectConstruction>;
  return (
    Object.keys(value).sort().join(",") === "keys,kind,schema" &&
    facts.schema === "source-object-construction-v1" &&
    (facts.kind === "data" || facts.kind === "method" || facts.kind === "prototype-setter") &&
    Array.isArray(facts.keys) &&
    facts.keys.length === fields.length &&
    facts.keys.every((key) => typeof key === "string") &&
    new Set(facts.keys).size === fields.length &&
    fields.every((field) => facts.keys!.includes(field.name))
  );
}
