// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// init-marshal-registry.ts — (#5193) the start-section marshalling-helper ABI.
//
// In the JS-host lane top-level code runs via the wasm `start` section, i.e.
// DURING `WebAssembly.instantiate`, so `setInstance` has not been called and
// `callbackState.getExports()` is `undefined` for the whole of module init.
// Every probe the runtime decodes a compiled value with is an EXPORT, so during
// init they are all unreachable — which is why a plain top-level
// `new Float64Array(new ArrayBuffer(8))` (jsbi's `__kBitConversionBuffer`)
// refused with "cannot marshal opaque compiled value".
//
// The module therefore hands the runtime those helpers itself, as `ref.func`
// values, from the top of `__module_init`. See
// `src/codegen/init-marshal-helpers.ts` for the emitting side.

/** State any marshalling path needs to resolve the helpers it may call. */
export interface MarshalExportSource {
  getExports: () => Record<string, Function> | undefined;
  getStartExports?: () => Record<string, Function> | undefined;
}

/**
 * Wire ABI: the ARRAY POSITION is the id `__register_init_export` receives.
 * Append only — an id is permanent. Keep in lock-step with
 * `INIT_MARSHAL_HELPERS` in `src/codegen/init-marshal-helpers.ts`.
 */
export const INIT_MARSHAL_HELPER_NAMES: readonly string[] = [
  "__vec_len",
  "__vec_get",
  "__is_vec",
  "__dv_byte_len",
  "__dv_byte_get",
  "__ab_max_len",
  // (#5208) The Date carrier's classifier + reader. Same window, same reason:
  // both are EXPORTS, so during the start section a compiled `Date` handed to a
  // host call could not even be RECOGNISED as one and fell through to the
  // generic struct proxy.
  "__\0js2_is_date",
  "__\0js2_date_value",
];

/**
 * Exports usable for compiled→host MARSHALLING right now: the real export
 * object after instantiation, else the funcrefs the module registered on
 * itself during its start section.
 *
 * Deliberately NOT folded into `getExports()`: the runtime has many
 * `getExports() !== undefined` branches that mean "post-instantiation", and
 * only the marshalling paths may see the earlier, partial set.
 */
export function marshalExports(
  callbackState?: MarshalExportSource,
  exports?: Record<string, Function>,
): Record<string, Function> | undefined {
  return exports ?? callbackState?.getExports() ?? callbackState?.getStartExports?.();
}

/**
 * (#5202) Split a `__register_init_class_export` name list exactly once per
 * distinct CSV. The module passes the SAME pooled string on every call — one
 * per dispatch export — so splitting per call would be quadratic on a bundle
 * with hundreds of methods.
 */
const _classDispatchNameLists = new Map<string, string[]>();

/** Resolve the `index`-th name of a `__register_init_class_export` CSV. */
export function classDispatchExportName(csv: unknown, index: number): string | undefined {
  if (typeof csv !== "string" || !Number.isInteger(index) || index < 0) return undefined;
  let names = _classDispatchNameLists.get(csv);
  if (names === undefined) {
    names = csv.length > 0 ? csv.split(",") : [];
    _classDispatchNameLists.set(csv, names);
  }
  return names[index];
}
