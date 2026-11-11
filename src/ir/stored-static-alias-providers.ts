// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 propertyHelper, #7272) The import signatures of the object-runtime
 * providers the stored-static aliases lower to (`uncurried-object-alias.ts`).
 * Each is legacy's own registration — `call-object-builtins.ts` for the
 * descriptor read, `emitArrayIsArrayExternrefPredicate` for `isArray` — so an
 * IR call and a legacy call of the same provider share one import. The bridge
 * (`integration.ts`) registers them.
 */

import type { ValType } from "./types.js";
import type { StoredStaticAliasProvider } from "./uncurried-object-alias.js";

const PROVIDER_IMPORTS: Readonly<
  Record<StoredStaticAliasProvider, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>
> = {
  __getOwnPropertyDescriptor: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [{ kind: "externref" }],
  },
  __getOwnPropertyNames: { params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
  __extern_is_array: { params: [{ kind: "externref" }], results: [{ kind: "i32" }] },
};

/** `symbol` names a stored-static alias provider. */
export function isStoredStaticAliasProvider(symbol: string): symbol is StoredStaticAliasProvider {
  return Object.hasOwn(PROVIDER_IMPORTS, symbol);
}

/** `symbol`'s import signature, as legacy registers it. */
export function storedStaticAliasProviderImport(symbol: StoredStaticAliasProvider): {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
} {
  return PROVIDER_IMPORTS[symbol];
}
