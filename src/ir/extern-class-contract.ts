// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "./types.js";

/**
 * Slice 10 (#1169i) — the from-ast view of one extern-class entry. Mirrors
 * `ExternClassInfo` from `src/codegen/context/types.ts` but limits the
 * surface to what the from-ast layer needs to validate `new ExternClass(...)`,
 * `recv.method(...)`, and property access on extern-class receivers.
 *
 * Methods carry the LEGACY-registered signature shape: `params[0]` is the
 * receiver `externref` and `params[1..]` are the user args. The from-ast
 * lowerer slices off the receiver when matching call args against
 * `params.slice(1)`. Slicing here keeps the from-ast logic dispatch-free.
 */
export interface IrExternClassMeta {
  readonly className: string;
  readonly namespacePath?: readonly string[];
  /** Exact legacy/import registry prefix; may differ for namespaces. */
  readonly importPrefix: string;
  readonly constructorParams: readonly ValType[];
  readonly methods: ReadonlyMap<string, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>;
  readonly properties: ReadonlyMap<string, { readonly type: ValType; readonly readonly: boolean }>;
}
