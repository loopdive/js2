// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { captureTypedIrProgramInput, type IrProgramSourcePreparation } from "../../src/ir/program-source.js";
import { prepareNumberFormatRuntimeSupport } from "../../src/frontend/builtins/prepare-number-format.js";
import type { RuntimeManifestPolicy } from "../../src/ir/runtime-manifest.js";
import type { TypedIrProgramInput } from "../../src/ir/program/input-contracts.js";

/** Frontend-side fixture capture; never imported by a source-free replay child. */
export function captureNativeFamilyRuntimeSupport(
  source: IrProgramSourcePreparation,
  policy: RuntimeManifestPolicy,
): TypedIrProgramInput {
  const support = prepareNumberFormatRuntimeSupport(source, policy);
  if (support?.batches.length !== 1) throw new Error("native family fixture requires one real formatter support batch");
  return captureTypedIrProgramInput(source, support);
}
