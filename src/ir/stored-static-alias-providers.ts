// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 propertyHelper, #7272, #7338) The import signatures of the
 * object-runtime providers the stored-static aliases
 * (`uncurried-object-alias.ts`) and the `Object` statics table
 * (`object-statics.ts`) lower to. Each is legacy's own registration —
 * `call-object-builtins.ts` for the descriptor read,
 * `emitArrayIsArrayExternrefPredicate` for `isArray`, `call-builtin-static.ts`
 * for `Object.create` — so an IR call and a legacy call of the same provider
 * share one import. The bridge (`integration.ts`) registers them.
 */

import type { ValType } from "./types.js";
import type { ObjectStaticProvider } from "./object-statics.js";
import type { StoredStaticAliasProvider } from "./uncurried-object-alias.js";

type ObjectRuntimeProvider = StoredStaticAliasProvider | ObjectStaticProvider;

const PROVIDER_IMPORTS: Readonly<
  Record<ObjectRuntimeProvider, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>
> = {
  __getOwnPropertyDescriptor: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [{ kind: "externref" }],
  },
  __getOwnPropertyNames: { params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
  __extern_is_array: { params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
  __object_create: { params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
};

/** `symbol` names one of these providers. */
export function isStoredStaticAliasProvider(symbol: string): symbol is ObjectRuntimeProvider {
  return Object.hasOwn(PROVIDER_IMPORTS, symbol);
}

/** `symbol`'s import signature, as legacy registers it. */
export function storedStaticAliasProviderImport(symbol: ObjectRuntimeProvider): {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
} {
  return PROVIDER_IMPORTS[symbol];
}
