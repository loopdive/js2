// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export {
  preparedGeneratorNumberBoxProvider,
  preparedStringCompareProvider,
  preparedStringEqProvider,
  preparedStringLenProvider,
  preparedStringConcatProvider,
  preparedStringCharCodeAtProvider,
  preparedStringConcatManyProvider,
  stringConstFeatureFor,
  preparedStringConstProvider,
  preparedHostCallbackWrapProvider,
  preparedFunctionPrototypeCallProvider,
  IrRuntimeFunctionPreparationError,
  prepareIrRuntimeManifest,
} from "./runtime/intrinsic-preparation.js";
export type { IrRuntimeManifestDemands, PrepareIrRuntimeManifestInput } from "./runtime/intrinsic-preparation.js";
export type { PreparedIrRuntimeManifest } from "./runtime/contracts/prepared.js";
export { verifyIrIntrinsicInstruction } from "./runtime/intrinsic-verification.js";
