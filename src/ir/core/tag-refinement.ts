// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * An opaque identifier for one partition of a {@link TagDomain}.
 *
 * Deliberately BRANDED. `IrType`'s dynamic leaf carries a `TagId`, not a
 * `JsTag`, so the IR core cannot name an ECMAScript partition by accident:
 * a bare `number` (and therefore a numeric-enum member such as `JsTag.String`)
 * is not assignable here. The only sanctioned ways to obtain one are a
 * domain's own exported constants (e.g. `JS_TAG_IDS.String`) or
 * {@link asTagId} inside a domain implementation.
 *
 * The underlying representation is a plain number, and each domain is free to
 * choose the numbering. The JS domain deliberately reuses the `JsTag` values,
 * which are ABI — they must match the runtime tags written by the
 * `__any_box_*` helpers in `codegen/any-helpers.ts`.
 */
declare const TAG_ID_BRAND: unique symbol;
export type TagId = number & { readonly [TAG_ID_BRAND]: "ir.TagId" };

/** Structural equality of two optional tag refinements. */
export function tagRefinementEquals(a: TagId | undefined, b: TagId | undefined): boolean {
  return (a ?? null) === (b ?? null);
}
