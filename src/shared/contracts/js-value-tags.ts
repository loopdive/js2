// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Canonical ECMAScript boxed-value ABI. Numeric values match __any_box_*
 * runtime tags; NumberI32 and NumberF64 are the same language type.
 * This import-free contract owns the existing enum and carrier function.
 * The neutral IR core continues to carry opaque TagIds.
 */
export enum JsTag {
  Null = 0,
  Undefined = 1,
  NumberI32 = 2,
  NumberF64 = 3,
  Boolean = 4,
  String = 5,
  Object = 6,
  Function = 7,
}

/**
 * #2949 slice 1 — the Wasm-carrier *kind* of a `JsTag` partition's unboxed
 * payload on the WasmGC backend, per the ratified #1852 representation table
 * and the `$AnyValue` struct layout (`any-helpers.ts`:
 * `{tag:i32, i32val:i32, f64val:f64, refval:eqref, externval:externref}`).
 *
 * Used by the IR verifier to check `unbox`/`tag.test` consistency on
 * `dynamic`-typed operands:
 *
 *   - `"i32"` / `"f64"` — exact scalar payload kind; the unbox target
 *     ValType must match exactly (NumberI32/Boolean → i32val, NumberF64 →
 *     f64val).
 *   - `"ref"` — the partition's payload is reference-shaped (String →
 *     externval or a native `$AnyString` ref; Object/Function → refval or
 *     externval). The exact ValType is a backend/resolver decision at
 *     lowering time, so the verifier only requires a ref-shaped target.
 *   - `null` — the partition has NO payload (Null/Undefined are singleton
 *     partitions). `unbox` with these tags is invalid; identity is observed
 *     via `tag.test` alone.
 */
export function jsTagUnboxKind(tag: JsTag): "i32" | "f64" | "ref" | null {
  switch (tag) {
    case JsTag.NumberI32:
    case JsTag.Boolean:
      return "i32";
    case JsTag.NumberF64:
      return "f64";
    case JsTag.String:
    case JsTag.Object:
    case JsTag.Function:
      return "ref";
    case JsTag.Null:
    case JsTag.Undefined:
      return null;
  }
}

/** Exact ABI aliases for proofs of boxed scalar producers. */
export const JS_NUMBER_F64_TAG = JsTag.NumberF64;
export const JS_BOOLEAN_TAG = JsTag.Boolean;
