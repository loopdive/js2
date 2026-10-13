// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  prepareIrProgramPresentation,
  type IrProgramPresentationRequest,
  type PreparedIrPipelinePresentationResult,
} from "./ir-program-presentation.js";
import type { CompileResult } from "../index.js";
import { PreparedIrProgramInvariantError } from "../ir/program.js";

/** The native Linear public route uses the shared source preparation and consumer. */
export function prepareNativeLinearPipeline(request: IrProgramPresentationRequest) {
  const { backend, target } = request.backendOptions;
  if (backend !== "linear" || (target !== "standalone" && target !== "wasi"))
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "native Linear invocation requires its explicit no-host backend and environment",
    );
  if (request.preparation.policy.backend !== backend || request.preparation.policy.target !== target)
    throw new PreparedIrProgramInvariantError(
      "invalid-transaction-capability",
      "native Linear preparation and consumption policies differ",
    );
  return prepareIrProgramPresentation(request);
}

/** Preserve produced artifact fields without inventing legacy route telemetry. */
export function preparedPipelineArtifacts(
  result: CompileResult,
): Extract<PreparedIrPipelinePresentationResult, { kind: "artifacts" }>["artifacts"] {
  return {
    binary: result.binary,
    wat: result.wat,
    dts: result.dts,
    importsHelper: result.importsHelper,
    success: result.success,
    errors: result.errors,
    stringPool: result.stringPool,
    sourceMap: result.sourceMap,
    imports: result.imports,
    runtimeRecGroupFingerprint: result.runtimeRecGroupFingerprint,
    targetProfile: result.targetProfile,
    hostImportInventory: result.hostImportInventory,
    hostImportSummary: result.hostImportSummary,
    capabilityRequirements: result.capabilityRequirements,
    capabilityProviderDiagnostics: result.capabilityProviderDiagnostics,
    cHeader: result.cHeader,
    wit: result.wit,
    hasMain: result.hasMain,
    hasTopLevelStatements: result.hasTopLevelStatements,
    exportSignatures: result.exportSignatures,
    exportBoundaryPolicies: result.exportBoundaryPolicies,
    adapterManifest: result.adapterManifest,
    explanation: result.explanation,
  };
}
