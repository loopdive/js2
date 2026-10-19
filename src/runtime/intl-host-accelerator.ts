// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6986) The `intl` host accelerator: host `Intl` calls marshalled through the
 * JS value boundary.
 *
 * Under the native semantic regime every value a Wasm module hands the host is
 * Wasm-owned — a native string, a boxed number, an object literal used as an
 * options bag — and every value the host returns has to come back as the
 * regime's carrier. The `Intl_<Class>_*` extern-class imports therefore convert
 * each argument with the boundary's `toHost` (primitives unwrap; a Wasm object
 * becomes the host view whose property reads the Intl constructor performs) and
 * the result with `fromHost` (strings become native strings, numbers boxed
 * carriers, host objects ADMITTED so their members read through the boundary
 * object MOP). Both converters are INJECTED, so this module never imports
 * runtime.ts.
 *
 * Only selected under `hostAccelerators: ["intl"]`; the host-assisted lane binds
 * the same imports unwrapped.
 */

import { externClassAcceleratorFamily, INTL_EXTERN_CONSTRUCTOR_NAMES } from "../extern-class-identity.js";

type Exports = Record<string, Function>;
type ExportsSource = { getExports(): Exports | undefined };

/** Is `imp` an `Intl.*` extern-class import routed by the selected `intl` accelerator? */
export function isIntlAcceleratedImport(
  imp: { intent: { type: string; name?: string; className?: string; namespacePath?: readonly string[] } },
  accelerators: readonly string[] | undefined,
): boolean {
  if (accelerators?.includes("intl") !== true) return false;
  if (imp.intent.type === "builtin") return intlBuiltinTarget(imp.intent.name) !== undefined;
  if (imp.intent.type === "declared_global") return imp.intent.name === "Intl";
  return (
    imp.intent.type === "extern_class" &&
    typeof imp.intent.className === "string" &&
    externClassAcceleratorFamily({ className: imp.intent.className, namespacePath: imp.intent.namespacePath }) ===
      "intl"
  );
}

/** The locale-sensitive builtin methods codegen routes as `__intl_<method>` (host-intl-locale.ts). */
const INTL_LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString", "localeCompare"]);

/**
 * What an `__intl_*` builtin import calls: `{ method }` for `__intl_<method>`
 * (receiver first), or `{ owner, fn }` for `__intl_static_[<Class>_]<fn>`.
 */
function intlBuiltinTarget(
  name: string | undefined,
): { method: string } | { owner: string | undefined; fn: string } | undefined {
  if (!name?.startsWith("__intl_")) return undefined;
  const rest = name.slice("__intl_".length);
  if (INTL_LOCALE_METHODS.has(rest)) return { method: rest };
  const match = /^static_(?:([A-Za-z]+)_)?([A-Za-z]+)$/.exec(rest);
  return match ? { owner: match[1], fn: match[2]! } : undefined;
}

/** Codegen pads absent arguments with null: pass them as `undefined` and drop trailing ones. */
function callArguments(values: readonly unknown[]): unknown[] {
  const args = values.map((value) => (value === null ? undefined : value));
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  return args;
}

/**
 * The host function behind an `__intl_*` builtin import (the marshalling wrapper
 * converts its receiver, arguments and result), or undefined for any other import.
 */
export function intlLocaleMethodImport(
  imp: { intent: { type: string; name?: string } },
  accelerators: readonly string[] | undefined,
): Function | undefined {
  if (accelerators?.includes("intl") !== true || imp.intent.type !== "builtin") return undefined;
  const target = intlBuiltinTarget(imp.intent.name);
  if (target === undefined) return undefined;
  if ("method" in target) {
    return (receiver: any, ...rest: unknown[]) => receiver[target.method](...callArguments(rest));
  }
  return (...rest: unknown[]) => {
    const intl = Intl as unknown as Record<string, any>;
    const owner = target.owner === undefined ? intl : intl[target.owner];
    return owner[target.fn](...callArguments(rest));
  };
}

export function marshalIntlHostImport(
  fn: Function,
  exportsSource: ExportsSource,
  toHost: (value: unknown, exports: Exports) => unknown,
  fromHost: (value: unknown, exports: Exports) => unknown,
  dateToHost: (value: unknown, exports: Exports) => unknown,
  toVector: (values: readonly unknown[], exports: Exports) => unknown,
): Function {
  return function intlHostImport(this: unknown, ...args: unknown[]) {
    const exports = exportsSource.getExports();
    if (!exports) return fn.apply(this, args);
    for (let i = 0; i < args.length; i++) {
      // A compiled Date reaches `format(date)` as its host Date view (#5208), not a struct facade.
      const date = dateToHost(args[i], exports);
      args[i] = date instanceof Date ? date : toHost(args[i], exports);
    }
    const result = fn.apply(this, args);
    // `formatToParts`, `supportedLocalesOf`, `getCanonicalLocales`: a host array becomes the
    // regime's native vector so `.length` / indexing read it; its elements cross like any result.
    return Array.isArray(result) ? toVector(result, exports) : fromHost(result, exports);
  };
}

/** The host's `Intl` constructors the extern-class registry binds (absent members are skipped). */
export function intlHostConstructors(): Record<string, Function> {
  const out: Record<string, Function> = {};
  if (typeof Intl === "undefined") return out;
  const intl = Intl as unknown as Record<string, unknown>;
  for (const name of INTL_EXTERN_CONSTRUCTOR_NAMES) {
    if (typeof intl[name] === "function") out[name] = intl[name] as Function;
  }
  return out;
}
