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

import { INIT_MARSHAL_HELPER_NAMES } from "../shared/contracts/init-marshal-helpers.js";

export { INIT_MARSHAL_HELPER_NAMES };

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

/** The lifecycle hook the start-section registrations write to. */
type StartExportSink = { registerStartExport?: (name: string, fn: Function) => void };

/**
 * The providers of the start-section registrations, or `undefined` when
 * `name` is neither. `__register_init_export(id, fn)` (#5193) hands over one
 * of the fixed {@link INIT_MARSHAL_HELPER_NAMES}; `__register_init_class_export
 * (namesCsv, index, fn)` (#5202) one class-method dispatch export. A funcref
 * crossing into JS is the identical function the export later yields, so this
 * is a timing shim, not a second ABI. Unknown ids and indices are ignored, so
 * an older runtime tolerates a newer module.
 */
export function resolveInitExportImport(
  name: string,
  callbackState: MarshalExportSource | undefined,
): Function | undefined {
  const sink = callbackState as StartExportSink | undefined;
  if (name === "__register_init_export") {
    return (id: number, fn: Function): void => {
      const helperName = INIT_MARSHAL_HELPER_NAMES[id];
      if (helperName !== undefined) sink?.registerStartExport?.(helperName, fn);
    };
  }
  if (name === "__register_init_class_export") {
    return (namesCsv: unknown, index: number, fn: Function): void => {
      const exportName = classDispatchExportName(namesCsv, index);
      if (exportName !== undefined) sink?.registerStartExport?.(exportName, fn);
    };
  }
  return undefined;
}
