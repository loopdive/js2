// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Typed-array brand identity at the JS-host boundary.
 *
 * Numeric TypedArrays and ordinary Arrays deliberately share ONE compact
 * `$Vec` carrier, so the brand is a side table: codegen calls
 * `__register_typed_array(vec, kind)` for values a TypedArray constructor
 * produced, and everything downstream reads that tag.
 *
 * #5362/#5675 taught the OUTBOUND marshaller (`_wrapForHost`) to honour it.
 * (#5370) adds the two answers that still contradicted it:
 *
 *   * the INBOUND direction — a host-built typed array narrowed into a fresh
 *     `$Vec` (the `__vec_from_extern_<N>` materializer, and every other
 *     cross-representation copy that runs the sidecar bridge) arrived
 *     unbranded, so it was indistinguishable from `[1,2,3]` and the next
 *     crossing out re-emitted a plain `Array`. Measured on the parent:
 *     `new TextEncoder().encode("abc")` returned through a compiled function
 *     whose inferred return type is `Uint8Array` read back as
 *     `constructor.name === "Array"`;
 *   * `.constructor` on a branded carrier, which answered %Array% from the
 *     generic vec arm while `_wrapForHost` was presenting the same value to
 *     host APIs as a real `Uint8Array`.
 *
 * An adopted brand and a compiled-origin brand are the same small integer, so
 * there is one mirror path downstream, not two.
 */

/**
 * Contract: keep in lock-step with `TYPED_ARRAY_HOST_TAGS` in
 * `codegen/expressions/typed-array-host-carrier.ts`. Index zero is
 * intentionally empty, so `0` doubles as "no brand".
 */
export const COMPILED_TYPED_ARRAY_CTORS: ReadonlyArray<Function | undefined> = [
  undefined,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  typeof BigInt64Array === "function" ? BigInt64Array : undefined,
  typeof BigUint64Array === "function" ? BigUint64Array : undefined,
];
