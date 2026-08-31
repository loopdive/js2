// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Naming convention for the hidden accessors the package linker substitutes for
 * a linked import binding.
 *
 * `package-linker.ts` rewrites `import { K } from "pkg"` in a CONSUMER module
 * to `const K = __js2wasm_get_K_<hash>()`, so by the time codegen sees the
 * consumer's source the provider's declarations are simply not there. Codegen
 * needs to RECOGNISE that shape (#5241): a value that came from one of these
 * accessors is an opaque cross-module value whose members can only be resolved
 * at run time, so compile-time member heuristics that assume a locally visible
 * declaration must decline for it.
 *
 * The prefixes live here rather than being spelled twice because the recogniser
 * and the generator failing apart would be silent — the consumer would just go
 * back to guessing.
 */

export const LINKED_IMPORT_GETTER_PREFIX = "__js2wasm_get_";
export const LINKED_IMPORT_REEXPORT_PREFIX = "__js2wasm_reexport_";

/** Is `name` one of the linker's hidden per-binding accessors? */
export function isLinkedImportAccessorName(name: string): boolean {
  return name.startsWith(LINKED_IMPORT_GETTER_PREFIX) || name.startsWith(LINKED_IMPORT_REEXPORT_PREFIX);
}
