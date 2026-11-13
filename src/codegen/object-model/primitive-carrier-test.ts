// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The struct types a primitive value is carried in on a standalone lane — the
 * one list behind two questions:
 *
 * - (#6651 V10a) "Is this externref a bare PRIMITIVE carrier?" at run time
 *   (`primitiveCarrierTestInstrs`): an i31 / boxed number, a boxed boolean, a
 *   native string, a `$Symbol`. Used where the spec's GetV / Invoke (§7.3.2,
 *   §7.3.20) must ToObject a primitive `this` while an object-only predicate
 *   would answer "no such property": `Promise.prototype.catch.call(true)` must
 *   find `Boolean.prototype.then`. Absent carrier types are skipped, so a
 *   module that never mints one emits no test for it.
 * - (#7194) "Does allocating this struct create a primitive, not an Object?"
 *   at finalize (`primitiveAllocationTypes`).
 *
 * The string family enters each question in the form it needs: the abstract
 * `$AnyString` for a `ref.test` (subtyping covers every form), the concrete
 * forms for a `struct.new` (only concrete types are allocated).
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

const I31_HEAP_TYPE = -20;

/** The shared list, in the runtime test's order; `strings` is the string family's form. */
function primitiveCarrierTypes(ctx: CodegenContext, strings: readonly number[]): number[] {
  return [ctx.nativeBoxNumberTypeIdx, ctx.nativeBoxBooleanTypeIdx, ...strings, ctx.symbolTypeIdx];
}

export function primitiveCarrierTestInstrs(ctx: CodegenContext, valueLocal: number): Instr[] {
  const typeIdxs = [I31_HEAP_TYPE, ...primitiveCarrierTypes(ctx, [ctx.anyStrTypeIdx])].filter(
    (idx) => idx === I31_HEAP_TYPE || idx >= 0,
  );
  const out: Instr[] = [];
  typeIdxs.forEach((typeIdx, i) => {
    out.push({ op: "local.get", index: valueLocal }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx });
    if (i > 0) out.push({ op: "i32.or" });
  });
  return out;
}

/**
 * Struct types whose allocation is never an Object: the shared carriers with
 * the concrete string forms, plus two the runtime test does not ask about.
 * A BigInt is a primitive, but the #6651 test has never matched it (adding it
 * there would change that test's bytes). `$AnyValue` is the internal box that
 * wraps any primitive, not a value a program sees.
 */
export function primitiveAllocationTypes(ctx: CodegenContext): Set<number> {
  const strings = [ctx.nativeStrTypeIdx, ctx.consStrTypeIdx, ctx.hashedStrTypeIdx, ctx.utf8StrTypeIdx];
  return new Set(
    [...primitiveCarrierTypes(ctx, strings), ctx.nativeBigIntTypeIdx, ctx.anyValueTypeIdx].filter((idx) => idx >= 0),
  );
}
