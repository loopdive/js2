// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Binaryen feature flags for Wasm that remains loadable by the engines js2
 * targets. `--all-features` is needed to read our post-MVP instructions, but
 * it also enables proposal encodings that Binaryen may introduce while
 * rewriting an otherwise portable module.
 */
export const BINARYEN_BASE_FEATURE_FLAGS = [
  "--all-features",
  // Binaryen can refine ordinary GC references into exact references.
  "--disable-custom-descriptors",
] as const;

export const BINARYEN_COMPACT_IMPORTS_DISABLE_FLAG = "--disable-compact-imports" as const;

export const BINARYEN_PORTABLE_FEATURE_FLAGS = [
  ...BINARYEN_BASE_FEATURE_FLAGS,
  // Binaryen 132 can rewrite ordinary imports into proposal kind 0x7e, which
  // Node 25 and current Wasmtime do not accept.
  BINARYEN_COMPACT_IMPORTS_DISABLE_FLAG,
] as const;
