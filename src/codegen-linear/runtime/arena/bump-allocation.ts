// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Retained direct callers use the same canonical physical builder identities.
export {
  describeLinearBumpArena,
  buildLinearBumpAllocationBody,
  buildLinearBumpAllocationCommitBody,
} from "../../../wasm/physical/linear-bump-allocation.js";
