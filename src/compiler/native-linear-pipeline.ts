// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { prepareIrProgramPresentation, type IrProgramPresentationRequest } from "./ir-program-presentation.js";
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

export { preparedPipelineArtifacts } from "./pipeline-result-finalizer.js";
