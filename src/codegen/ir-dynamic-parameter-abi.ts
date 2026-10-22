// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { jsDocParamIsExternrefCandidate, effectiveIrParamTypeNode } from "../ir/select.js";
import { hostFreeEnvironment, type CodegenContext } from "./context/types.js";
import { legacyParamSlotIsExternref } from "./fnctor-typed-instances.js";

/** The physical slot, not an any annotation alone, proves the dynamic ABI. */
export function parameterHasDynamicExternrefAbi(ctx: CodegenContext, parameter: ts.ParameterDeclaration): boolean {
  const type = effectiveIrParamTypeNode(parameter);
  return (
    (jsDocParamIsExternrefCandidate(parameter) ||
      (!ctx.fast && hostFreeEnvironment(ctx) && type?.kind === ts.SyntaxKind.AnyKeyword)) &&
    legacyParamSlotIsExternref(ctx, parameter)
  );
}
