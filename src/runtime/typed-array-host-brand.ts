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

/**
 * Keyed by `Object.prototype.toString`, not `constructor.name`: the tag is an
 * own internal-slot answer, so a subclass (`class Bytes extends Uint8Array`)
 * and a cross-realm instance both resolve, while a renamed constructor cannot
 * forge one.
 */
const HOST_TYPED_ARRAY_KINDS: Readonly<Record<string, number>> = {
  "[object Int8Array]": 1,
  "[object Uint8Array]": 2,
  "[object Uint8ClampedArray]": 3,
  "[object Int16Array]": 4,
  "[object Uint16Array]": 5,
  "[object Int32Array]": 6,
  "[object Uint32Array]": 7,
  "[object Float32Array]": 8,
  "[object Float64Array]": 9,
  "[object BigInt64Array]": 10,
  "[object BigUint64Array]": 11,
};

const _objectToString = Object.prototype.toString;

/**
 * The brand tag a HOST value would carry, or `0` when it is not a numeric
 * typed array. `DataView` answers `0` on purpose: the compiled lane carries it
 * on its own `$__dv_window` struct, never on a `$Vec`.
 */
export function hostTypedArrayKind(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (!ArrayBuffer.isView(value)) return 0;
  return HOST_TYPED_ARRAY_KINDS[_objectToString.call(value)] ?? 0;
}

/**
 * Carry `source`'s typed-array brand onto the freshly materialized carrier
 * `destination`, when there is one to carry.
 *
 * Both origins reach here through the same sidecar bridge, so one call covers
 * them: `source` may be a genuine host typed array (inbound narrowing) or an
 * already-branded compiled carrier being re-materialized into a different vec
 * representation — `kinds` answers the latter.
 *
 * Deliberately a no-op when `source` carries no brand. An unbranded vec must
 * STAY unbranded, or every `[1,2,3]` copied across a representation boundary
 * would start claiming to be a typed array.
 */
export function adoptTypedArrayBrand(
  source: unknown,
  destination: unknown,
  normalize: (value: unknown) => unknown,
  kinds: WeakMap<object, number>,
  canBeWeakKey: (value: unknown) => boolean,
): void {
  const from = normalize(source);
  const to = normalize(destination);
  if (to === null || typeof to !== "object" || !canBeWeakKey(to)) return;
  let kind = hostTypedArrayKind(from);
  if (kind === 0 && from !== null && typeof from === "object" && canBeWeakKey(from)) {
    kind = kinds.get(from as object) ?? 0;
  }
  if (kind !== 0) kinds.set(to as object, kind);
}

/**
 * The constructor a branded carrier must report, resolved against the active
 * test262 sandbox realm when there is one (`vec.constructor === Uint8Array`
 * has to hold for the sandbox's intrinsic, exactly as the vec arm does for
 * %Array%). `undefined` means "not branded" — the caller falls through.
 */
export function compiledTypedArrayConstructorFor(
  carrier: unknown,
  kinds: WeakMap<object, number>,
  canBeWeakKey: (value: unknown) => boolean,
  sandbox: Record<string, unknown> | undefined,
): unknown {
  if (carrier === null || typeof carrier !== "object" || !canBeWeakKey(carrier)) return undefined;
  const kind = kinds.get(carrier as object);
  const ctor = kind === undefined ? undefined : COMPILED_TYPED_ARRAY_CTORS[kind];
  if (ctor === undefined) return undefined;
  return sandbox?.[ctor.name] ?? ctor;
}
