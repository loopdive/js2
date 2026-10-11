// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Compatibility exports; implementation belongs to the prepared-program owner. */
export {
  locatedFailure,
  invariant,
  checkFunctionPopulation,
  prepareWholeProgramRuntimeManifest,
} from "./program/runtime-manifest.js";
export type {
  PrepareWholeProgramRuntimeManifestInput,
  PreparedWholeProgramRuntimeManifest,
} from "./program/runtime-manifest.js";
