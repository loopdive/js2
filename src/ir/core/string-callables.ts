// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Canonical backend-neutral identities for immutable string concatenation. */
export const IR_STRING_CONCAT_FN = "__ir_string_concat";
/** Semantic prefix for an exact host-provided fixed-arity concat operation. */
export const IR_STRING_CONCAT_MANY_PREFIX = "string.concat$arity";

export function irStringConcatManySymbol(arity: number): string {
  if (!Number.isInteger(arity) || arity < 3) {
    throw new RangeError(`string concat-many arity must be an integer >= 3, got ${arity}`);
  }
  return `${IR_STRING_CONCAT_MANY_PREFIX}${arity}`;
}
